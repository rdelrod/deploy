/**
 * deploy - a deployment server utilizing Github web hooks to deploy code.
 *
 * @author Jared Allard <jaredallard@outlook.com>
 * @license MIT
 * @version 1.0.0
 **/

'use strict';

let   pmx     = require('pmx');
pmx.init({
  http: true,
  network: true
});

let   express = require('express'),
      request = require('request'),
      fs      = require('fs'),
      replay  = require('request-replay'),
      async   = require('async'),
      nodegit = require('nodegit'),
      path    = require('path'),
      github  = require('githubhook'),
      pm2     = require('pm2');

// our libraries.
const log     = require('./lib/log.js');
const slog    = function() {
  const args = Array.prototype.slice.call(arguments, 0);
  args.unshift('deploy');
  log.apply(log, args);
}
const extend = (target, source) => {
    for (let prop in source) {
      target[prop] = source[prop];
    }
    return target;
}

const config  = require('./config/config.json');

// instance our APIs
const app     = express();
const hook    = github(config.githubhook);

const LOGDIR  = path.join(__dirname, 'logs');

if(!fs.existsSync(LOGDIR)) {
  fs.mkdirSync(LOGDIR);
} else {
  let logs = fs.readdirSync(LOGDIR);
  logs.forEach(function(v) {
    let fullpath = path.join(LOGDIR, v);
    fs.unlinkSync(fullpath);
  })
}

pm2.connect(function(err) {
  if (err) {
    console.error(err);
    process.exit(2);
  }

  log('deploy:pm2', 'daemon started.');

  config.deployments.forEach(function(v) {
    let spath = v.path;
    let sname = v.name;
    let smain = v.main;

    let spm2   = v.pm2;
    let opts  = { // to make pm2
      script: path.join(spath, smain),
      name: sname,
      cwd: spath,
      exec_mode: 'fork'
    }

    // check for pm2 override / additions
    if(spm2) {
      opts = extend(opts, spm2.opts);
    }

    log('deploy:pm2', 'start', sname);
    pm2.start(opts, function(err) {
      if(err) {
        sendEvent('error', sname, {
          reason: 'Failed To Launch',
          stage: 'init'
        })
        return log('deploy:pm2', 'app:', sname, 'failed to start with:', err);
      }
    });
  });
});

let   STATUS             = 'idle',
      RUNNINGDEPLOYMENTS = [];

// Setup the REST API
app.get('/', function(req, res) {
  return res.send({
    success: false,
    reason: 'NOTFOUND'
  });
});

/**
 * /status
 *
 * Get The Deployment status
 **/
app.get('/status', function(req, res) {
  return res.send({
    status: STATUS,
    running: RUNNINGDEPLOYMENTS
  });
});

// Inject Socket.io for realtime updates.
let server = require('http').createServer(app);
server.path= '/realtime';

let io = require('socket.io')(server);
io.on('connection', function() {
  log('socket', 'recieved a connection')
});

const sendEvent = (event, repo, data) => {
  if(event === 'status') {
    if(data.inprogress) {
      STATUS = 'running';
    } else {
      STATUS = 'idle';
    }
  }

  // send the event
  io.emit({
    event: event,
    repo: repo,
    data: data
  });

  config.listeners.forEach(function(listener) {
    log('event', 'send event', event, 'to', listener.uri);

    replay(request(listener.uri, {
      method: 'post',
      body: {
        event: 'deploy',
        data: {
          event: event,
          repo: repo,
          data: data
        }
      },
      json: true
    }, function (err, response, body) {

    }), {
      retries: 10,
      factor: 3
    })
    .on('replay', function (replay) {
      // "replay" is an object that contains some useful information
      console.log('request failed: ' + replay.error.code + ' ' + replay.error.message);
      console.log('replay nr: #' + replay.number);
      console.log('will retry in: ' + replay.delay + 'ms')
    });
  });
}

server.listen(config.express.port);

// trigger on push event.
hook.on('push', function (repo, ref) {
  log('githubhook', repo, 'push event');

  sendEvent('deploy', 'recieved deploy request for: '+repo)

  sendEvent('status', repo, {
    inprogress: true
  });

  // push the code to our running table.
  RUNNINGDEPLOYMENTS.push({
    name: repo,
    status: 'running',
    started: Date.now()
  });

  let deployConfig = false;
  config.deployments.forEach((v) => {
    if(v.name === repo) {
      deployConfig = v;
    }
  });

  if(!deployConfig) {
    return log('githubhook', 'Not configured.');
  }

  // get our forever context
  async.waterfall([
    /**
     * Verify we're on the right branch.
     **/
    function(next) {
      if(ref !== config.githubhook.branch) {
        return next('Not Production branch: '+ref);
      }

      return next();
    },

    /**
     * Get the Forever Script context
     **/
    function(next) {
      pm2.list((err, list) => {
        if(err) {
          return log('github:pm2', 'Failed to obtain list of process.');
        }

        let proc = false;
        list.forEach((p) => {
          if(p.name === repo) {
            proc = p;
          }
        });

        if(!proc) {
          return next('We dont support: '+repo);
        }

        sendEvent('deploy', repo, 'found pm2 process');

        return next(false, proc);
      })
    },

    /**
     * Git "Pull"
     **/
    function(proc, next) {
      let spath = deployConfig.path;
      let repository;

      log('github:git', 'pulling new code...');
      sendEvent('deploy', repo, 'pulling origin & merging.')

      nodegit.Repository.open(spath)
        .then(function(repo) {
          repository = repo;

          return repository.fetchAll({
            callbacks: {
              credentials: function(url, userName) {
                return nodegit.Cred.sshKeyFromAgent(userName);
              },
              certificateCheck: function() {
                return 1;
              }
            }
          });
        })
        // Now that we're finished fetching, go ahead and merge our local branch
        // with the new one
        .then(function() {
          return repository.mergeBranches('production', 'origin/production');
        })
        .done(function() {
          sendEvent('deploy', repo, 'finished pulling production branch.');
          return next(false, proc);
        });
    },

    /**
     * Restart the Script
     **/
     function(proc, next) {
       log('github:pm2', 'restart service:', repo);
       sendEvent('deploy', repo, 'restart pm2 process.');
       pm2.restart(repo, (err) => {
         if(err) {
           return next(err);
         }

         log('github:pm2', 'restarted:', repo, 'successfully');
         sendEvent('deploy', repo, 'pm2 process restart');
         return next();
       })
     }
  ], function(err) {

    // Remove the deployment regardless of status
    let index = false;
    RUNNINGDEPLOYMENTS.forEach((v, i) => {
      if(v.name === repo) {
        index = i;
      }
    })

    log('github:express', 'Found RUNNINGDEPLOYMENTS#'+index, 'for pm2', repo);
    RUNNINGDEPLOYMENTS.splice(index, 1);

    if(err) {
      sendEvent('deploy', repo, 'deploy failed.');
      sendEvent('status', repo, {
        inprogress: false,
        success: false
      });
      sendEvent('error', repo, {
        reason: err,
        stage: 'deploy'
      });
      return log('githubhook', 'error:', err);
    }

    log('githubhook', 'deployed successfully.');
    sendEvent('deploy', repo, 'deploy finised.');
    sendEvent('status', repo, {
      inprogress: false,
      success: true
    });
  });
});

// Start the Github Event Listener.
hook.listen();

slog('initialized')

process.on('SIGINT', function() {
  console.log();
  slog('CTRL-C');
  process.exit();
});

process.on('exit', function(code) {
  slog('EXITING: THIS IS BAD.');

  pm2.list((err, p) => {
    if(err) {
      log('pm2', 'Failed to stop remaining processes.')
      return;
    }

    p.forEach(function(proc) {
      slog('pm2: stop', proc.name);
      pm2.stop(proc.name);
    });
  });
  // do logic to determine if crash or etc.
  slog('exit code:', code);
});
