const Drone = require('drone-node');
const plugin = new Drone.Plugin();

//const ArtifactoryAPI = require('./ArtifactoryAPI.js');
const pomParser = require("pom-parser");
const glob = require("glob");
const winston = require("winston");

const btoa = require('btoa');
const fls = require('fs');
const pathing = require('path');

const crypto = require('crypto');
//
const Q = require('q');
const _ = require('underscore');

const request = require('request');
const path = require('path');
const fs = require('fs');
const md5File = require('md5-file');

//
var expands_files = function (pathing, files) { return [].concat.apply([], files.map((f) => { return glob.sync(pathing + '/' + f); })); }

var publish_file = function (artifactory, repo_key, project, file, force_upload) {
  return new Promise((resolve, reject) => {
    var basename = pathing.basename(file);
    // If file to publish is a pom file, change name to official Maven requirements
    if (file.indexOf('pom') > -1) { basename = project.artifact_id + '-' + project.version + '.pom'; }

    winston.info('Uploading ' + file + ' as ' + basename + ' into ' + repo_key);
    return get_checksums(file).then((checksums) => {
      if(typeof checksums == "object") winston.info('Checksum Object');
      winston.info('Upload successful. SHA1 at: ' + checksums.sha1);
      winston.info('Upload successful. MD5 at: ' + checksums.md5);
      winston.info('Upload successful. SHA256 at: ' + checksums.sha256);
       artifactory.uploadFile(repo_key, '/' + replace_dots(project.group_id) + '/' + project.artifact_id + '/' + project.version + '/' + basename, file, force_upload, checksums)
       .then((uploadInfo) => {

      winston.info('Upload successful. Available at: ' + uploadInfo.downloadUri);
      winston.info('Upload successful. SHA1 at: ' + checksums.sha1);
      winston.info('Upload successful. MD5 at: ' + checksums.md5);
      winston.info('Upload successful. SHA256 at: ' + checksums.sha256);
         resolve();
       }).catch((err) => {

      reject('An error happened while trying to publish the file ' + file + ': ' + err);
       });
    });
  });
}

var do_upload = function (params) {
  // gets build and repository information for the current running build
  const workspace = params.workspace;

  // gets plugin-specific parameters defined in the .drone.yml file
  const vargs = params.vargs;
  const project = {
    group_id: vargs.group_id,
    artifact_id: vargs.artifact_id,
    version: vargs.version
  }

  if (vargs.log_level) { winston.level = vargs.log_level; }

  winston.info('Project groupId: ' + project.group_id);
  winston.info('Project artifactId: ' + project.artifact_id);
  winston.info('Project version: ' + project.version);

  var hash = btoa(vargs.username + ':' + vargs.password)
  var artifactory = ArtifactoryAPI(vargs.url, hash);

  // Default repo_key to 'libs-snapshot-local' or 'libs-release-local'
  if (!vargs.repo_key) { project.version.toLowerCase().indexOf('snapshot') > -1 ? vargs.repo_key = 'libs-snapshot-local' : vargs.repo_key = 'libs-release-local'; }

  return Promise.all(
    expands_files(workspace.pathing, vargs.files)
    .map((file) => { return publish_file(artifactory, vargs.repo_key, project, file, vargs.force_upload); })
  );
}

var check_params = function (params) {
  return new Promise((resolve, reject) => {
    // Create empty vargs for Drone 0.5
    params.vargs  || (params.vargs = {})

    // Set workspace pathing to CWD for Drone 0.5
    params.workspace || ((params.workspace = {}) && (params.workspace.pathing = process.cwd()))

    // First check if provided by Drone plugin (0.4)
    // Then check if provided as Drone 0.5 secret env
    // Then check if provided as Drone 0.5 plugin env
    // Then return default
    params.vargs.username      || (params.vargs.username = process.env.ARTIFACTORY_USERNAME) || (params.vargs.username = process.env.PLUGIN_USERNAME) || (params.vargs.username = '');
    params.vargs.password      || (params.vargs.password = process.env.ARTIFACTORY_PASSWORD) || (params.vargs.password = process.env.PLUGIN_PASSWORD) || (params.vargs.password = '');
    params.vargs.files         || (process.env.PLUGIN_FILES && (params.vargs.files = process.env.PLUGIN_FILES.split(','))) || (params.vargs.files = []);
    params.vargs.force_upload  || (params.vargs.force_upload = process.env.PLUGIN_FORCE_UPLOAD) || (params.vargs.force_upload = false);

    params.vargs.url         || (params.vargs.url = process.env.ARTIFACTORY_URL) || (params.vargs.url = process.env.PLUGIN_URL)
    params.vargs.group_id    || (params.vargs.group_id = process.env.PLUGIN_GROUP_ID)
    params.vargs.artifact_id || (params.vargs.artifact_id = process.env.PLUGIN_ARTIFACT_ID)
    params.vargs.version     || (params.vargs.version = process.env.PLUGIN_VERSION)
    params.vargs.pom         || (params.vargs.pom = process.env.PLUGIN_POM)
    params.vargs.repo_key    || (params.vargs.repo_key = process.env.PLUGIN_REPO_KEY)

    if (!params.vargs.url) {
      return reject("Artifactory URL is missing and Mandatory");
    }

    if (params.vargs.pom) {
      if (!fls.existsSync(params.workspace.pathing + '/' + params.vargs.pom)) {
        return reject('Given pom file has to exists: ' + params.workspace.pathing + '/' + params.vargs.pom);
      }

      pomParser.parse({ filePath: params.workspace.pathing + '/' + params.vargs.pom }, function(err, pomResponse) {
        if (err) { return reject('An error happened while trying to parse the pom file: ' + err); }

        params.vargs.group_id    || (params.vargs.group_id = pomResponse.pomObject.project.groupid);
        params.vargs.artifact_id || (params.vargs.artifact_id = pomResponse.pomObject.project.artifactid);
        params.vargs.version     || (params.vargs.version = pomResponse.pomObject.project.version);
        if (!params.vargs.group_id || !params.vargs.artifact_id || !params.vargs.version) {
          return reject('Some artifact details are missing from Pom file');
        }

        if(params.vargs.files.indexOf(params.vargs.pom)==-1) {
          // params.vargs.files.push(params.vargs.pom);
        }

        return resolve(params);
      });
    } else {
      if (!params.vargs.group_id || !params.vargs.artifact_id || !params.vargs.version) {
        return reject('Artifact details must be specified manually if no Pom file is given');
      }

      return resolve(params);
    }
  });
}

var get_checksums = function(file){
   return new Promise(function(resolve, reject){
     var stream = fls.createReadStream(file),
         md5 = crypto.createHash('md5'),
         sha1 = crypto.createHash('sha1'),
         sha256 = crypto.createHash('sha256');

     stream.on('data', function(data) {
       md5.update(data, 'utf8');
       sha1.update(data, 'utf8');
       sha256.update(data, 'utf8');
     });

     stream.on('end', function() {
       resolve({
         md5: md5.digest('hex'),
         sha1: sha1.digest('hex'),
         sha256: sha256.digest('hex')
       });
     });
   });
 }

var replace_dots = function(param){
  return param.replace(new RegExp('\\.', 'g'),'/');
}

// Expose public methods for tests
if(require.main === module) {
  // Drone is >= 0.5
  if(process.env.DRONE_VERSION) {
    check_params({})
    .then(do_upload)
    .catch((msg) => { winston.error(msg); process.exit(1); });

  // Drone is 0.4
  } else {
    plugin.parse()
    .then(check_params)
    .then(do_upload)
    .catch((msg) => { winston.error(msg); process.exit(1); });
  }
} else {
  module.exports = {
    check_params: check_params,
    expands_files: expands_files,
    do_upload: do_upload,
    replace_dots: replace_dots,
    get_checksums: get_checksums
  }
}
///-----------------------------------ARTIFACTORYAPI-----------------------------------------------------------------------///
/**
  Creates a new Artifactory API instance
  @class
*/
var ArtifactoryAPI = function(url, basicHttpAuth) {
  this.url_ = url;
  this.basicHttpAuth_ = basicHttpAuth;
}

/**
  @prop {object} API - General API sections
  @static
*/
ArtifactoryAPI.API = {
  storage: '/artifactory/api/storage/',
  build: '/artifactory/api/build'
};

/**
  @prop {object} ACTIONS - The ACTIONS listed here represent well-known paths for
  common artifactory actions.
  @static
*/
ArtifactoryAPI.ACTIONS = {
  'getFileInfo': ArtifactoryAPI.API.storage + '<%= repoKey %><%= filePath %>',
  'filePath': '/artifactory/' + '<%= repoKey %><%= filePath %>'
};

/** Get file info from Artifactory server. The result is provided in a json object.
 * @param   {string} repoKey  The key of the repo where the file is stored.
 * @param   {string} remotefilePath The path to the file inside the repo.
 * @returns {object} A QPromise to a json object with the file's info as specified in the {@link http://www.jfrog.com/confluence/display/RTF/Artifactory+REST+API#ArtifactoryRESTAPI-FileInfo|FileInfo} Artifactory API.
 */
var getFileInfo = function (repoKey, remotefilePath) {
  var deferred = Q.defer();

  var compiled = _.template(ArtifactoryAPI.ACTIONS.getFileInfo);

  var actionPath = compiled({
    repoKey: repoKey,
    filePath: remotefilePath
  });

  var options = {
    url: this.url_ + actionPath,
    headers: {
      'Authorization': 'Basic ' + this.basicHttpAuth_
    },
    strictSSL: false
  };

  request.get(options, function (error, response) {
    if (error) {
      deferred.reject(error.message);
      return;
    }
    //We expect an OK return code.
    if (response.statusCode !== 200) {
      deferred.reject(response.statusCode);
      return;
    }
    deferred.resolve(JSON.parse(response.body));
  });

  return deferred.promise;
};

/**
 * Checks if the file exists.
 * @param   {string} repoKey  The key of the repo where the file is stored.
 * @param   {string} remotefilePath The path to the file inside the repo.
 * @returns {object} A QPromise to a boolean value
 */
var fileExists = function (repoKey, remotefilePath) {
  var deferred = Q.defer(),
    compiled = _.template(ArtifactoryAPI.ACTIONS.filePath),
    actionPath = compiled({
      repoKey: repoKey,
      filePath: remotefilePath
    }),
    options = {
      url: this.url_ + actionPath,
      headers: {
        'Authorization': 'Basic ' + this.basicHttpAuth_
      },
      strictSSL: false
    };

  request.head(options, function (error, response) {
    switch (response.statusCode) {
    case 200:
      deferred.resolve(true);
      break;
    case 404:
      deferred.resolve(false);
      break;
    default:
      deferred.reject(response.statusCode);
      break;
    }
  });

  return deferred.promise;
};

/**
 * Uploads a file to artifactory. The uploading file needs to exist!
 * @param   {string} repoKey  The key of the repo where the file is stored.
 * @param   {string} remotefilePath The path to the file inside the repo. (in the server)
 * @param   {string} fileToUploadPath Absolute or relative path to the file to upload.
 * @param   {boolean} [forceUpload=false] Flag indicating if the file should be upload if it already exists.
 * @param   {object} checksums
 * @param   {string} checksums.md5
 * @param   {string} checksums.sha1
 * @returns {object} A QPromise to a json object with creation info as specified in the {@link http://www.jfrog.com/confluence/display/RTF/Artifactory+REST+API#ArtifactoryRESTAPI-DeployArtifact|DeployArtifact} Artifactory API.
 */
var uploadFile = function (repoKey, remotefilePath, fileToUploadPath, forceUpload, checksums) {
  var deferred = Q.defer(),
    overwriteFileInServer = forceUpload || false,
    isRemote = !!fileToUploadPath.match(/^https?:\/\//i),
    fileToUpload = isRemote ? fileToUploadPath : path.resolve(fileToUploadPath);

  /*
    Check the file to upload does exist! (if local)
  */
  if (!isRemote && !fs.existsSync(fileToUpload)) {
    deferred.reject('The file to upload ' + fileToUpload + ' does not exist');
    return deferred.promise;
  }

  /*
    Create everything for doing the request
  */
  var compiled = _.template(ArtifactoryAPI.ACTIONS.filePath),
    actionPath = compiled({
      repoKey: repoKey,
      filePath: remotefilePath
    }),
    options = {
      url: this.url_ + actionPath,
      headers: {
        'Authorization': 'Basic ' + this.basicHttpAuth_
      },
      strictSSL: false
    };

  if(typeof checksums == "object") {
    if(checksums.sha1) options.headers['X-Checksum-Sha1'] = checksums.sha1
    if(checksums.md5) options.headers['X-Checksum-Md5'] = checksums.md5
  }

  //Check if file exists..
  this.fileExists(repoKey, remotefilePath).then(function (fileExists) {
    if (fileExists && !overwriteFileInServer) {
      deferred.reject('File already exists and forceUpload flag was not provided with a TRUE value.');
      return;
    }

    var stream = isRemote ? request(fileToUpload) : fs.createReadStream(fileToUpload);
    //In any other case then proceed with *upload*
    stream.pipe(request.put(options, function (error, response) {
      if (error) {
        deferred.reject(error.message);
        return;
      }
      //We expect a CREATED return code.
      if (response.statusCode !== 201) {
        deferred.reject('HTTP Status Code from server was: ' + response.statusCode);
        return;
      }
      deferred.resolve(JSON.parse(response.body));
    }));
  }).fail(function (err) {
    deferred.reject(err);
  });

  return deferred.promise;
};

/** Downloads an artifactory artifact to a specified file path. The folder where the file will be created MUST exist.
 * @param   {string} repoKey  The key of the repo where the file is stored.
 * @param   {string} remotefilePath The path to the file inside the repo. (in the server)
 * @param   {string} destinationFile Absolute or relative path to the destination file. The folder that will contain the destination file must exist.
 * @param   {boolean} [checkChecksum=false] A flag indicating if a checksum verification should be done as part of the download.
 * @returns {object} A QPromise to a string containing the result.
 */
var downloadFile = function (repoKey, remotefilePath, destinationFile, checkChecksum) {
  var deferred = Q.defer(),
    checkFileIntegrity = checkChecksum || false,
    self = this,
    destinationPath = path.resolve(destinationFile);

  if (!fs.existsSync(path.dirname(destinationPath))) {
    deferred.reject('The destination folder ' + path.dirname(destinationPath) + ' does not exist.');
    return deferred.promise;
  }

  var compiled = _.template(ArtifactoryAPI.ACTIONS.filePath);

  var actionPath = compiled({
    repoKey: repoKey,
    filePath: remotefilePath
  });

  var options = {
    url: this.url_ + actionPath,
    headers: {
      'Authorization': 'Basic ' + this.basicHttpAuth_
    },
    strictSSL: false
  };

  var req = request.get(options);
  req.on('response', function (resp) {
    if (resp.statusCode === 200) {
      var stream = req.pipe(fs.createWriteStream(destinationPath));
      stream.on('finish', function () {
        if (checkFileIntegrity) {
          self.getFileInfo(repoKey, remotefilePath).then(function (fileInfo) {
            md5File(destinationPath, function (err, sum) {
              if (err) {
                deferred.reject('Error while calculating MD5: ' + err.toString());
                return;
              }
              if (sum === fileInfo.checksums.md5) {
                deferred.resolve('Download was SUCCESSFUL even checking expected checksum MD5 (' + fileInfo.checksums.md5 + ')');
              } else {
                deferred.reject('Error downloading file ' + options.url + '. Checksum (MD5) validation failed. Expected: ' +
                  fileInfo.checksums.md5 + ' - Actual downloaded: ' + sum);
              }
            });
          }).fail(function (err) {
            deferred.reject(err);
          });
        } else {
          deferred.resolve('Download was SUCCESSFUL');
        }
      });
    } else {
      deferred.reject('Server returned ' + resp.statusCode);
    }
  });

  return deferred.promise;
};

/** Upload Build Information
 * @param   {object} buildInfo - see build.json {@link https://www.jfrog.com/confluence/display/RTF/Artifactory+REST+API#ArtifactoryRESTAPI-BuildUpload} {@link https://github.com/JFrogDev/build-info#build-info-json-format}
 * @returns {object} A QPromise to a string containing the result.
 */
var uploadBuild = function (buildInfo) {
  var deferred = Q.defer();
  if(buildInfo.name && _.isString(buildInfo.name)) {
    buildInfo.name = buildInfo.name.trim();
  }

  if(buildInfo.number) {
    if(_.isNumber(buildInfo.number)) {
      buildInfo.number = buildInfo.number.toString();
    } else if(_.isString(buildInfo.number)) {
      buildInfo.number = buildInfo.number.trim();
    }
  }

  if(!buildInfo.name || !buildInfo.number ||
     buildInfo.name.length == 0 || buildInfo.number.length == 0) {

    deferred.reject('Build Info must include a name and number. See https://www.jfrog.com/confluence/display/RTF/Artifactory+REST+API#ArtifactoryRESTAPI-BuildUpload for more info');
    return deferred.promise;
  }
  buildInfo.name = buildInfo.name.trim();
  buildInfo.number = buildInfo.number.trim();

  var options = {
    url: this.url_ + ArtifactoryAPI.API.build,
    headers: {
      'Authorization': 'Basic ' + this.basicHttpAuth_
    },
    strictSSL: false,
    json: buildInfo
  };

  request.put(options, function (error, response) {
    if (error) {
      deferred.reject(error.message);
      return;
    }
    //We expect a NO CONTENT return code.
    if (response.statusCode !== 204) {
      deferred.reject('HTTP Status Code from server was: ' + response.statusCode);
      return;
    }
    deferred.resolve();
  });

  return deferred.promise;
}
