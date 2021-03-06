import pm2 from 'pm2';

import path from 'path';

import getLogger from './logger';
import LOG_LEVEL from './logLevels';

export const connect = () =>
  new Promise((resolve, reject) => {
    pm2.connect(err => {
      if (err) {
        reject(err);
      } else {
        resolve(() => pm2.disconnect());
      }
    });
  });

export const startApp = async (name, args, workers, daemon) => {
  const disconnect = await connect();
  const log = getLogger();
  log(LOG_LEVEL.DEBUG, {
    type: 'child-process-starting',
    payload: {
      request: workers,
    },
  });
  return new Promise((resolve, reject) => {
    pm2.start(
      {
        script: path.resolve(__dirname, './server.js'),
        name: `heq-server-${name}`,
        args: `'${JSON.stringify(args)}'`,
        exec_mode: 'cluster',
        instances: workers || 1,
        max_memory_restart: '100M',
        interpreterArgs: ['-r', 'babel-register'],
      },
      (err, apps) => {
        if (err) {
          reject(err);
          return;
        }

        log(LOG_LEVEL.INFO, {
          type: 'child-process-started',
          payload: {
            instances: apps.length,
          },
        });

        const app = {
          name,
          instances: apps,
        };

        if (daemon) {
          disconnect();
          resolve(app);
          return;
        }

        let manuallyStopping = false;

        pm2.launchBus((err, bus) => {
          bus.on('process:event', args => {
            if (manuallyStopping) {
              return;
            }
            if (args.event === 'exit' && args.process.status === 'stopping') {
              log(LOG_LEVEL.FATAL, {
                type: 'begin-shutdown',
                payload: { name, forced: true },
              });
            }

            if (args.event === 'exit' && args.process.status === 'stopped') {
              log(LOG_LEVEL.FATAL, {
                type: 'complete-shutdown',
                payload: { name, forced: true },
              });
              process.exit(1);
            }
          });
          bus.on('log:out', ({ data, process }) => {
            if (data.slice(0, 7) !== '{"type"') {
              log(LOG_LEVEL.INFO, {
                type: 'server-log',
                payload: {
                  process,
                  msg: data.trim(),
                },
              });
            } else {
              const original = JSON.parse(data);
              original.payload.process = process;
              log(original._l, original);
            }
          });

          bus.on('log:err', ({ data, process }) => {
            if (data.slice(0, 7) !== '{"type"') {
              log(LOG_LEVEL.ERROR, {
                type: 'server-err',
                payload: {
                  process,
                  error: data.split('\n')[1],
                },
              });

              log(LOG_LEVEL.DEBUG, {
                type: 'server-err-stack',
                payload: {
                  process,
                  stack: data.split('\n').slice(2),
                },
              });
            } else {
              console.error(data);
            }
          });
        });

        process.on('SIGINT', async () => {
          console.log('');
          manuallyStopping = true;
          log(LOG_LEVEL.INFO, { type: 'begin-shutdown', payload: { name } });
          await stopApp(name);
          log(LOG_LEVEL.INFO, { type: 'complete-shutdown', payload: { name } });
          disconnect();
          resolve();
        });
      }
    );
  });
};

export const stopApp = async app => {
  const log = getLogger();
  const fullName = `heq-server-${app}`;
  const disconnect = await connect();
  return new Promise((resolve, reject) => {
    // setTimeout(resolve, 500);
    pm2.delete(fullName, err => {
      disconnect();
      if (err) {
        if (err.message == 'process name not found') {
          log(LOG_LEVEL.ERROR, {
            type: 'cannot-stop',
            payload: { reason: 'DID_NOT_START', app },
          });
          return;
        }

        log(LOG_LEVEL.ERROR, {
          type: 'cannot-stop',
          payload: { reason: 'UNEXPECTED', message: err.message, app },
        });

        resolve();
      } else {
        resolve();
      }
    });
  });
};

export const listApps = async () => {
  const disconnect = await connect();
  return new Promise((resolve, reject) => {
    pm2.list((err, apps) => {
      if (err) {
        reject(err);
      } else {
        const eventsServerApps = apps.filter(({ name }) =>
          name.startsWith('heq-server-')
        );
        resolve(eventsServerApps);
        disconnect();
      }
    });
  });
};
