var urllib = require('url');
var mungeResponse = require('./mungeResponse');
var osutils = require('./os-utils');



//constructor - should be the only export
function Glance(endpoint_url, auth_token, call_timeout)
{
  //we need to overwrite this for unit testing and it allows us to use a custom request object that includes graphite logging
  this.request = require('request');
  
  //endpoint_url should come from the keystone projectInfo call - also yank all the trailing slashes in case folks get clever
  this.url = endpoint_url.replace(/\/$/, "");
  
  //auth_token should be the scoped token from the projectInfo call
  this.token = auth_token;
  
  //default the timeout in case one isn't set
  if(typeof call_timeout == 'undefined')
  {
    this.timeout = 9000;
  }
  this.timeout = call_timeout;
}



//lets us override the existing request lib for this instance (useful for a bunch of things)
Glance.prototype.setRequest = function(request_lib)
{
  this.request = request_lib;
}


//returns an formatted options object - just makes the code below a little less repetitious
//path should begin with a "/"
//json_value should be almost certainly be true if you don't have an actual object you want to send over
Glance.prototype.getRequestOptions = function(path, json_value, extra_headers)
{
  var return_object = {
    uri: this.url + path,
    headers:{'X-Auth-Token': this.token},
    json: json_value,
    timeout: this.timeout
  };
  
  //add the extra header info if it exists
  if(typeof extra_headers != 'undefined')
  {
    for(var key in extra_headers)
    {
      if(extra_headers.hasOwnProperty(key))
      {
        return_object.headers[key] = extra_headers.key;
      }
    }
  }

  return return_object;
};



//gets a list of all of the available images for a given project/user
//takes a standalone callback that will get called with up to 2 params (error, list_object)
Glance.prototype.list = function(cb)
{
  var request_options = this.getRequestOptions('/images?member_status=all', true);
  request_options.logPath = 'api-calls.glance.images-list'; //if you override the request obj you can use this for logging purposes

  this.request.get(request_options, function(error, response, body){
    if(osutils.isError(error, response) || !body.images)
    {
      console.log('request_options', request_options);
      console.log('response_body', body);
      
      cb(osutils.getError('glance.list', error, response, body));
      return;
    }

    //munge to clean up various things
    cb(null, mungeResponse(body.images));
  });
}



//gets info on a specific image given the id
//takes an image id ex: '8ab808ed-d2aa-471c-9af0-0d3287061670'
//and callback with 2 params (error, image_info_object)
Glance.prototype.get = function(id, cb)
{
  var request_options = this.getRequestOptions('/images/' + escape(id), true);
  request_options.logPath = 'api-calls.glance.images-get';

  this.request.get(request_options, function(error, response, body){
    if(osutils.isError(error, response) || !body.id)
    {
      console.log('request_options', request_options);
      console.log('glance get body', body);
      cb(osutils.getError('glance.get', error, response, body));
      return;
    }

    //apparently munge adds {image:} above the response?
    cb(null, mungeResponse(body));
  });
}



//This might create a temporary id/placeholder for us to upload new images into
//...or it may bring the end of times through dark titual.... probably 50/50
//callback takes 2 params (error, data) where data seems to include the id of the result of queuing...er posting... er whatever
Glance.prototype.queue = function(data, cb)
{
  var post_data = {};
  var request_options = {};

  //first pull the valid options out of data - I think this is done for security purposes...as opposed to just tossing in 'data'?
  if(data.name)
  {
    post_data.name = data.name;
  }
  if(data.visibility)
  {
    post_data.visibility = data.visibility;
  }
  if(data.tags)
  {
    post_data.tags = data.tags;
  }
  if(data.disk_format)
  {
    post_data.disk_format = data.disk_format;
  }
  if(data.container_format)
  {
    post_data.container_format = data.container_format;
  }

  request_options = this.getRequestOptions('/images', post_data);
  request_options.logPath = 'api-calls.glance.images-queue';

  this.request.post(request_options, function(error, response, body){
    if(osutils.isError(error, response) || !body.id)
    {
      cb(osutils.getError('glance.queue', error, response, body));
      return;
    }

    //munge here does things!... with stuff! for... reasons! yeah...
    cb(null, mungeResponse(body));
  });
}



//uploads a new image to openstack
//takes the new image id(from the queue call above?)
//a stream object... don't really get that one (download result?)
//and a callback w/2 params (error, response) I think response here is the result of the upload call
Glance.prototype.upload = function(id, stream, cb)
{
  var http;
  var upload;
  var url = this.url + '/images/' + escape(id) + '/file';
  var opt = urllib.parse(url); //sadly I didn't get this working with the request object.... yet!
  opt.method = 'PUT';
  opt.headers = {
    'X-Auth-Token': this.token,
    'Content-Type': 'application/octet-stream',
    'Connection'  : 'close'
  };

  if(opt.protocol == 'https:')
  {
    http = require('https');
  }
  else
  {
    http = require('http');
  }

  upload = http.request(opt, function(res){
    var response = '';

    res.on('data', function(chunk){
      response += chunk;
    });

    res.on('end', function(){
      console.log('Upload done:', response)
      cb(null, response);
    });
  });

  upload.on('error', function(e) {
    cb(e);
  });

  stream.pipe(upload);
}



//updates an image in openstack something
//takes the the image id to be updated as well as an object with the deltas to be tweaked
//callback takes 2 params (error, result)
Glance.prototype.update = function(id, data, cb)
{
  var request_options = {};
  //patch requires an array for data...?
  var patch_data = [];

  if(data.name)
  {
    patch_data.push({"replace": "/name", "value": data.name});
  }
  if(data.visibility)
  {
    patch_data.push({"replace": "/visibility", "value": data.visibility});
  }
  //data.protected is a boolean so the normal if(thing) mechanism won't work - hence typeof
  if(typeof data.protected != 'undefined')
  {
    patch_data.push({"replace": "/protected", "value": !!data.protected});
  }
  if(data.tags)
  {
    patch_data.push({"replace": "/tags", "value": data.tags});
  }


  //content type if set seems to not get overridden by the json value being set (normally doing that sets the CT to json)
  request_options = this.getRequestOptions('/images/' + escape(id), patch_data, {'Content-Type': 'application/openstack-images-v2.1-json-patch'});
  request_options.logPath = 'api-calls.glance.images-update';

  this.request.patch(request_options, function(error, response, body){
    if(osutils.isError(error, response) || !body.id)
    {
      cb(osutils.getError('glance.update', error, response, body));
      return;
    }

    //munge here does things!... with stuff! for... reasons! yeah...
    cb(null, mungeResponse(body));
  });
}



//removes an image form the openStack something
//takes the image id and calls cb with (error, result) whateve result is..
Glance.prototype.remove = function(id, cb)
{
  var request_options = this.getRequestOptions('/images' + escape(id), true);
  request_options.logPath = 'api-calls.glance.images-remove';

  //are we not giving this a cb for some reason sometimes???
  function noop()
  {
    //this does absolutely nothing - and thats just the way we like it!
  }
  if(!cb)
  {
    cb = noop;
  }

  this.request.del(request_options, function(error, response, body){
    if(osutils.isError(error, response) || !body.id)
    {
      cb(osutils.getError('glance.remove', error, response, body));
      return;
    }

    //no clue what munge is munging in this munge of mungeness
    cb(null, mungeResponse(body));
  });
}


module.exports = Glance;