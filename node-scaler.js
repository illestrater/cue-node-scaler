require('dotenv').config();
const fs = require('fs');
const _ = require('lodash');
const axios = require('axios');
const request = require('request');
const winston = require('winston');
const jwt = require('jsonwebtoken');

const ENV = process.env;

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.json(),
  transports: [
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' })
  ]
});

logger.add(new winston.transports.Console({
  format: winston.format.simple()
}));

const vaultOptions = {
  apiVersion: 'v1',
  endpoint: 'https://env.cue.dj:8200',
  token: fs.readFileSync(ENV.VAULT_TOKEN, 'utf8').trim()
};

const loadBalancerID = '00e4399b-4acd-46c3-8391-56d0b2585d35';

const Vault = require('node-vault')(vaultOptions);

Vault.read('secret/env').then(async vault => {
  const secrets = vault.data;
  const SERVICE_KEY = secrets.service_key;

  const api = axios.create({
    baseURL: 'https://api.digitalocean.com/',
    responseType: 'json',
    crossDomain: true
  });

  axios.defaults.headers.common.Authorization = secrets.digitalocean_key;

  const MINIMUM_DROPLETS = 1;
  const HEALTH_CPU_THRESHOLD = 80;

  let initializing = false;
  let initialized = true;
  let clearInitialization = false;
  let availableDroplets = [];
  let serverPromises = [];

  function updateLoadBalancers(remove) {
    const dropletIDs = [];
    availableDroplets.forEach((droplet) => {
      dropletIDs.push(droplet.id);
    });

    if (remove) {
      dropletIDs.pop();
    }

    console.log('DROPLET IDS', dropletIDs);

    api.put(`v2/load_balancers/${ loadBalancerID }`, {
      name: 'cue-nodes',
      region: 'sfo2',
      algorithm: 'round_robin',
      forwarding_rules: [
        {
          entry_protocol: 'https',
          entry_port: 443,
          target_protocol: 'http',
          target_port: 1111,
          certificate_id: '9a06069b-ff21-4378-967b-90e7a6515ce9'
        }
      ],
      health_check: {
        protocol: 'tcp',
        port: 1111,
        check_interval_seconds: 10,
        response_timeout_seconds: 5,
        healthy_threshold: 5,
        unhealthy_threshold: 3
      },
      sticky_sessions: {},
      droplet_ids: dropletIDs
    }).then(() => { console.log('UPDATED LOAD BALANCER'); })
    .catch(err => { console.log('LOAD BALANCER ERROR', err); });
  }

  function checkNewDroplet(droplet) {
    initializing = false;
    initialized = false;
    if (clearInitialization) {
      clearInterval(clearInitialization);
      clearInitialization = false;
    }

    const initializationChecker = setInterval(() => {
      const found = _.find(availableDroplets, (drop) => drop.id === droplet.id);
      if (found) {
        if (found.networks.v4.length > 0) {
          const ip = found.networks.v4[0].ip_address;
          console.log('GOT DROPLET IP', ip);
          request({
            url: `http://${ ip }:1111/api/health`,
            method: 'POST',
            json: { jwt: jwt.sign({}, SERVICE_KEY) }
          }, (err, response, body) => {
            console.log('NEW DROPLET', body);
            if (body && !body.error && body.usage && body.usage.cpu) {
              initialized = true;
              initializing = droplet.id;
              updateLoadBalancers();
              clearInitialization = setTimeout(() => {
                initializing = false;
              }, 60000 * 5);
              console.log('CLEARING CHECKER');
              clearInterval(initializationChecker);
            }
          });
        }
      }
    }, 5000);

    setTimeout(() => {
      if (!initializing && availableDroplets.length > MINIMUM_DROPLETS) {
        api.delete(`v2/droplets/${ droplet.id }`)
        .then(() => console.log(`DESTROYED DEAD DROPLET ${ droplet.id }`));
        clearInterval(initializationChecker);
        initialized = true;
      }
    }, 60000 * 5);
  }

  function createDroplet() {
    console.log('CREATING DROPLET');
    initializing = true;
    api.post('v2/droplets',
    {
      name: 'cue-node',
      region: 'sfo2',
      size: 's-1vcpu-1gb',
      image: '46011811',
      ssh_keys: ['20298220', '20398405'],
      backups: 'false',
      ipv6: false,
      user_data: '#cloud-config\nruncmd:\n - git -C /root/cue-server pull origin scaling\n - /usr/bin/yarn --cwd /root/cue-server\n - /root/.nvm/versions/node/v8.15.1/bin/forever start /root/cue-server/server/server.js',
      private_networking: null,
      monitoring: false,
      volumes: null,
      tags: ['nodejs']
    }).then((res) => {
      console.log('CREATED!', res.data.droplet);
      checkNewDroplet(res.data.droplet);
    })
    .catch((err) => {
      console.log('ERROR CREATING DROPLET', err);
      initializing = false;
    });
  }

  function deleteDroplet(droplet) {
    api.delete(`v2/droplets/${ droplet }`)
    .then((res) => { console.log('DROPLET DELETED', droplet); })
    .catch(err => {});
  }

  // api.get('v2/images?private=true').then((res) => console.log(res.data));
  logger.info(`INITIALIZING TRANSCODER ROTATOR WITH: ${ MINIMUM_DROPLETS } MINIMUM DROPLETS`);

  // Load monitor
  setInterval(() => {
      api.get('v2/droplets?tag_name=nodejs')
      .then(res => {
        if (res.data) {
          if (res.data.id !== 'service_unavailable') {
            availableDroplets = res.data.droplets;
          }

          // Run check one at a time, and while not initializing new droplet
          if (serverPromises.length === 0 && initialized) {
            // Gather health of all droplets
            for (let i = 0; i < availableDroplets.length; i++) {
              if (availableDroplets[i].networks.v4[0]) {
                const ip = availableDroplets[i].networks.v4[0].ip_address;
                serverPromises.push(
                  new Promise((resolve, reject) => {
                    request({
                      url: `http://${ ip }:1111/api/health`,
                      method: 'POST',
                      json: { jwt: jwt.sign({}, SERVICE_KEY) }
                    }, (err, response, body) => {
                      if (body) {
                        body.droplet = availableDroplets[i].id;
                        body.ip = ip;
                        resolve(body);
                      } else {
                        reject(err);
                      }
                    });
                  }).catch(err => {})
                );
              }
            }

            Promise.all(serverPromises).then((values) => {
              let availableCount = 0;
              let totalCPU = 0;
              values.forEach(node => {
                if (!node.error && node.usage && node.usage.cpu) {
                  totalCPU += node.usage.cpu;
                  availableCount++;
                }
              });

              const averageCPU = totalCPU / availableCount;
              console.log(averageCPU, totalCPU, availableCount);
              if (averageCPU > HEALTH_CPU_THRESHOLD && !initializing) {
                console.log('starting new droplet');
                createDroplet();
              }

              serverPromises = [];
            });
          }
        }
      })
      .catch(err => { console.log('GOT ERROR', err); });
  }, 10000);
});
