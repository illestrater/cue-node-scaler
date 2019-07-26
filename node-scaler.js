require('dotenv').config();
const fs = require('fs');
const _ = require('lodash');
const axios = require('axios');
const request = require('request');
const winston = require('winston');
const jwt = require('jsonwebtoken');
const express = require('express');
const https = require('https');
const cors = require('cors');
const bodyParser = require('body-parser');

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
  const HEALTH_CPU_THRESHOLD_UPPER = 80;
  const HEALTH_CPU_THRESHOLD_LOWER = 60;

  let initializing = false;
  let initialized = true;
  let destroying = false;
  let clearInitialization = false;
  let deploy = false;
  let deploying = false;
  let availableDroplets = [];
  let serverPromises = [];

  function deleteDroplet(droplet) {
    api.delete(`v2/droplets/${ droplet }`)
    .then((res) => { console.log('DROPLET DELETED', droplet); })
    .catch(err => {});
  }

  function updateLoadBalancers(remove, ids) {
    const dropletIDs = [];
    availableDroplets.forEach((droplet) => {
      dropletIDs.push(droplet.id);
    });

    let destroy;
    if (remove) {
      destroy = dropletIDs.pop();
    } else if (ids) {
      ids.forEach(id => {
        const index = dropletIDs.indexOf(id);
        if (index > -1) {
          dropletIDs.splice(index, 1);
        }
      });
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
          target_port: 80,
          certificate_id: '95615b86-03ce-4085-aba9-4fc281921d74'
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
      enable_proxy_protocol: true,
      sticky_sessions: {},
      droplet_ids: dropletIDs
    }).then(() => {
      console.log('UPDATED LOAD BALANCER');
      if (remove) {
        console.log('DELETING DROPLET SOON', destroy);
        setTimeout(() => {
          destroying = false;
          deleteDroplet(destroy);
        }, 60000);
      } else if (ids) {
        console.log('DELETING DROPLETS SOON', ids);
        logger.info(`FULLY DEPLOYED ${ new Date() }`);
        setTimeout(() => {
          destroying = false;
          deploying = false;
          ids.forEach(id => {
            deleteDroplet(id);
          });
        }, 60000);
      }
    })
    .catch(err => {
      destroying = false;
      console.log('LOAD BALANCER ERROR', err);
    });
  }

  function checkNewDroplet(droplet) {
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
              }, 60000 * 4);
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
      image: '49940476',
      ssh_keys: ['20298220', '20398405'],
      backups: 'false',
      ipv6: false,
      user_data: '#cloud-config\nruncmd:\n - /etc/init.d/nginx start\n - git -C /root/cue-server pull origin master\n - mkdir /root/cue-server/images\n - /usr/bin/yarn --cwd /root/cue-server\n - /root/.nvm/versions/node/v8.15.1/bin/forever start /root/cue-server/server/server.js',
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

  // api.get('v2/certificates').then((res) => console.log(res.data));
  // api.get('v2/images?private=true').then((res) => console.log(res.data));
  logger.info(`INITIALIZING NODE SCALER WITH ${ MINIMUM_DROPLETS } MINIMUM DROPLETS`);

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
                if (node && !node.error && node.usage) {
                  totalCPU += node.usage.cpu;
                  availableCount++;
                }
              });

              if (deploying && !initializing && !destroying) {
                destroying = true;
                updateLoadBalancers(false, deploying);
                logger.info(`REDIRECTED TRAFFIC ${ new Date() }`);
              }

              // SERVER DEPLOYMENT
              if (deploy) {
                deploy = false;
                deploying = [];
                availableDroplets.forEach(droplet => deploying.push(droplet.id));
                logger.info(`DEPLOYING ${ new Date() }`);
                for (let i = 0; i < values.length; i++) {
                  createDroplet();
                }
              }

              if (!deploying && !initializing) {
                const averageCPU = totalCPU / availableCount;
                console.log(averageCPU, totalCPU, availableCount);

                // UPSCALE
                if ((averageCPU > HEALTH_CPU_THRESHOLD_UPPER || availableDroplets.length < MINIMUM_DROPLETS)) {
                  logger.info(`UPSCALING ${ new Date() }`);
                  createDroplet();
                }

                // DOWNSCALE
                if (averageCPU < HEALTH_CPU_THRESHOLD_LOWER && availableDroplets.length > MINIMUM_DROPLETS && !destroying) {
                  logger.info(`DOWNSCALING ${ new Date() }`);
                  destroying = true;
                  updateLoadBalancers(true, null);
                }
              }

              serverPromises = [];
            }).catch(err => { console.log('got unhandled', err); });
          }
        }
      })
      .catch(err => { console.log('GOT ERROR', err); });
  }, 10000);

  const app = express();
  app.use(cors());
  app.use(bodyParser.json());

  function verify(token, res, callback) {
    try {
        const verified = jwt.verify(token.jwt, SERVICE_KEY);
        return callback(verified);
    } catch (err) {
        return res.status(500).json('Authorization error');
    }
  }

  app.post('/deploy', (req, res) => {
    verify(req.body, res, () => {
      deploy = true;
      res.json('DEPLOYING');
    });
  });

  const options = {
    key:  fs.readFileSync(`${ ENV.CERT_LOCATION }/privkey.pem`, 'utf8'),
    cert: fs.readFileSync(`${ ENV.CERT_LOCATION }/fullchain.pem`, 'utf8')
  };
  const server = https.createServer(options, app);
  server.listen(2345);
});
