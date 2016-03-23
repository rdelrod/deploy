/**
 * deploy - a deployment server utilizing Github web hooks to deploy code.
 *
 * @author Jared Allard <jaredallard@outlook.com>
 * @license MIT
 * @version 1.0.0
 **/

'use strict';

let   pmx     = require('pmx'),
      request = require('request'),
      replay  = require('request-replay'),
      async   = require('async'),
      nodegit = require('nodegit'),
      spawn   = require('child_process').spawn,
      path    = require('path'),
      github  = require('githubhook'),
      pm2     = require('pm2');

// early init pmx
pmx.init({
  http: true,
  network: true
});


// our libraries.
const log     = require('./lib/log.js'),
      io      = require('./lib/web.js');

// load the config
const config  = require('./config/config.json');

// instance our APIs
const hook    = github(config.githubhook);

/**
 * log symlink to act as deploy "thread"
 *
 * @returns {undefined} nothing!
 **/
const slog    = function() {
  const args = Array.prototype.slice.call(arguments, 0);
  args.unshift('deploy');
  log.apply(log, args);
}

/**
 * Join an array.
 *
 * @param {Array} target - array to insert into
 * @param {Array} source - array to inject into insert.
 *
 * @returns {Array} combined array.
 **/
const extend = (target, source) => {
    for (let prop in source) {
      target[prop] = source[prop];
    }
    return target;
}

/**
 * Send events.
 *
 * @param {String} event  - event name
 * @param {String} repo   - repository name
 * @param {Variable} data - data to send with event.
 *
 * @returns {undefined} nothing
 **/
const sendEvent = function(event, repo, data) {
  if(event === 'status') {
    if(data.inprogress) {
      global.STATUS = 'running';
    } else {
      global.STATUS = 'idle';
    }
  }

  // send the event
  io.sockets.emit(event, {
    event: event,
    repo: repo,
    data: data
  });

  config.listeners.forEach(function(listener) {
    log('event', 'send event', event, 'to', listener.uri);

    // wrap request in replay for if it goes down.
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
    }), {
      retries: 10,
      factor: 3
    })
    .on('replay', function() {
    });
  });
}

/**
 * Connect to our PM2 daemon
 *
 * This is the "startup" function.
 **/
pm2.connect(function(err) {
  if (err) {
    console.error(err);
    process.exit(1);
  }

  global.status = 'init';
  log('deploy:pm2', 'daemon started.');

  /**
   * Grab the list of running pm2 process.
   **/
  pm2.list((err, list) => {
    let running = {};
    list.forEach((proc) => {
      let status = proc.pm2_env.status;

      // default value.
      running[proc.name] = false;
      if(status !== 'stopped') {
        running[proc.name] = true;
      }

      log('deploy:pm2', proc.name, 'is', status);
    })

    /**
     * Start a new pm2 process for our deployments.
     **/
    config.deployments.forEach(function(v) {
      let spath = v.path;
      let sname = v.name;
      let smain = v.main;

      if(running[sname]) { // check if it's already running
        return;
      }

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

  global.status = 'idle';
});

// trigger on push event.
hook.on('push', function (repo, ref) {
  log('githubhook', repo, 'push event');

  sendEvent('deploy', 'recieved deploy request for: '+repo)

  sendEvent('status', repo, {
    inprogress: true
  });

  let deployConfig = false;
  config.deployments.forEach((v) => {
    if(v.name === repo) {
      deployConfig = v;
    }
  });

  if(!deployConfig) {
    sendEvent('deploy', 'Deploy isn\'t configured to deploy this repo! :(')
    return log('githubhook', 'Not configured.');
  }


  // Run through the deployment system
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
     * Run post instructions
     **/
    function(proc, next) {
      let cobj = false;
      config.deployments.forEach(function(v) {
        if(v.name === repo) {
          cobj = v;
        }
      });

      if(!cobj) {
        return next('Failed to obtain config object.');
      }

      // check if it even has post instructions.
      if(cobj.post === undefined) {
        cobj.post = [];
      }

      let post = extend(cobj.post, config.global.post);
      log('github:post', 'running post code.');
      async.each(post, (cmdstr, cb) => {
        let opts = cmdstr.split(' ');
        let cmd  = opts.shift();

        sendEvent('deploy', '$ '+cmdstr);

        // spawn the process
        let postc = spawn(cmd, opts, {
          cwd: cobj.path
        });

        postc.stdout.on('data', (data) => {
          data = data.toString('utf8');
          sendEvent('deploy', data);
        })

        postc.stderr.on('data', (data) => {
          data = data.toString('utf8');
          sendEvent('deploy', data);
        })

        postc.on('exit', () => {
          return cb();
        })
      }, (err) => {
        return next(err, proc);
      })
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

process.on('SIGINT', () => {
  console.log();
  slog('CTRL-C');
  process.exit();
});

process.on('exit', () => {
  slog('EXITING: THIS IS BAD.');
  pm2.disconnect();
});
