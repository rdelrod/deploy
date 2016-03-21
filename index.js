/**
 * deploy - a deployment server utilizing Github web hooks to deploy code.
 *
 * @author Jared Allard <jaredallard@outlook.com>
 * @license MIT
 * @version 1.0.0
 **/

'use strict';

const express = require('express'),
      fs      = require('fs'),
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
    for (var prop in source) {
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

  log('deployments', 'pm2 started.');

  config.deployments.forEach(function(v) {
    let spath = v.path;
    let sname = v.name;
    let stype = v.type;
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
      if(spm2.opts) {
        opts = extend(opts, spm2.opts);
      }
    }

    if(stype === 'nodejs') {
      log('deployments', 'start', sname);
      log('deployments', 'pm2 opts:', opts);

      pm2.start(opts, function(err) {
        if(err) {
          return log('deployments', 'app:', sname, 'failed to start with:', err);
        }
      });
    }
  });
});

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

});

// Inject Socket.io for realtime updates.
let server = require('http').createServer(app);
server.path= '/realtime';

let io = require('socket.io')(server);
io.on('connection', function() {
  log('socket', 'recieved a connection')
});
server.listen(config.express.port);

// trigger on push event.
hook.on('push', function (repo, ref, data) {
  log('githubhook', 'Got push event for:', repo);

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
     * Get the Forever Script context
     **/
    function(next) {
      pm2.list((err, list) => {
        if(err) {
          return log('github:pm2', 'Failed to obtain list of process.');
        }

        log('github:pm2', list);
      })
    },

    /**
     * Git "Pull"
     **/
    function(foreverContext, next) {
      let spath = deployConfig.path;
      let repository;

      log('githubhook', 'pulling new code...');

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
          return repository.mergeBranches('master', 'origin/master');
        })
        .done(function() {
          return next(false, foreverContext);
        });
    },

    /**
     * Restart the Script
     **/
     function(foreverContext, next) {
       log('githubhook', 'restart service:', repo);
       return next();
     }
  ], function(err) {
    if(err) {
      return log('githubhook', 'error:', err);
    }

    log('githubhook', 'deployed successfully.');
  });
});

// Start the Github Event Listener.
hook.listen();

slog('initialized')

process.on('SIGINT', function() {
  slog( "Gracefully shutting down from SIGINT (Ctrl-C)" );
  process.exit();
});

process.on('exit', function(code) {
  slog('EXITING: THIS IS BAD.');

  // do logic to determine if crash or etc.
  slog('exit code:', code);
});
