const
	fs = require('fs'),
	AWS = require('aws-sdk'),
	mimetypes = require('mime-types'),
	//PQueue = require('p-queue'),
	os = require('os');

let fileTypeFromFile, PQueue;
import('file-type').then((fileTypeModule) => {
	fileTypeFromFile = fileTypeModule.fileTypeFromFile;
});  
import('p-queue').then((pQueueModule) => {
	PQueue = pQueueModule.default || pQueueModule;
});


module.exports = class s3driver {

	constructor() {
		this.s3 = null;
		this.bucket = null;

		this.dirs_concurrency = 15; // default
		this.files_concurrency = 50; // default
		this.queue_dirs = null;
		this.queue_files = null;
		this.queue = null; // old uploadDir2
	}

	/**
	 * Configures the S3 driver with the provided configuration.
	 * @param {Object} config - S3 configuration object.
	 */
	config(config) {
		this.s3 = new AWS.S3(config);
		this.bucket = config.bucket;
	    return;
	}

  	/**
	 * Uploads a directory to S3, including subdirectories and files, skips empty dirs
	 * @param {string} dir - Local directory path to upload.
	 * @param {string} [prefix=''] - Prefix to add to S3 object keys.
	 * @param {Object} [params={}] - Additional parameters for customization.
	 * @param {string} [params.acl=public-read] - Access control list. Default is "public-read."
	 * @param {boolean} [params.overwrite=false] - Whether to overwrite existing items. Default is "false"
	 * @param {boolean} [params.overwrite_if_newer=false] - Overwrite only if the source is newer. Default is "false"
	 * @param {number} [params.dirs_concurrency] - Number of concurrent directories operations.
	 * @param {number} [params.files_concurrency] - Number of concurrent files operations.
	 * @returns {Promise<boolean>} - A promise resolving to true if the upload is successful.
	 */
	async uploadDir(dir, prefix = '', params = {}) {
		console.log('uploadDir', dir, prefix);

		let
			overwrite = false,
			overwrite_if_newer = false,
			acl = 'public-read';

		if ('acl' in params && params.acl) {
			acl = params.acl;
		}
		if ('overwrite' in params && params.overwrite) {
			overwrite = true;
		}
		if ('overwrite_if_newer' in params && params.overwrite_if_newer) {
			overwrite = true;
			overwrite_if_newer = true;
		}

		// making sure queues initiated (or settings passed about changing concurrecy, so we reinitiate queues)
		if (null === this.queue_dirs || 'dirs_concurrency' in params) {
			this.queue_dirs = new PQueue({concurrency: ('dirs_concurrency' in params) ? params.dirs_concurrency : this.dirs_concurrency});
			delete params.dirs_concurrency;
		}
		if (null === this.queue_files || 'files_concurrency' in params) {
			this.queue_files = new PQueue({concurrency: ('files_concurrency' in params) ? params.files_concurrency : this.files_concurrency});
			delete params.files_concurrency;
		}


		//for (let i = 0; i <= 20; i++) this.upload('./test-files/test copy 85.js', 'lambda8/test copy 85.js').then(console.log); return;

		// adding trailing slash to add deeper path in the future
		if (!dir.endsWith('/')) dir += '/';
		// removing first slash, if exists
		prefix = prefix.replace(/^\//, '');

		let files_remote = await this.list(prefix, true);
		let files = fs.readdirSync(dir, { withFileTypes: true });


		//console.log(files_remote);
		//console.log('filling files/dir queue');

		for (let file of files) {

			if (file.isDirectory()) {
				//console.log('uploadDir', dir, file.name, prefix, file.name);

				this.queue_dirs.add(() => {
					return this.uploadDir(dir + file.name, prefix + file.name + '/', params);
				}, {priority : 0});

			} else {

				// searching for remote file in array
				let file_remote = files_remote.find(obj => {
				 	return file.name === obj.name
				});

				if (overwrite || undefined === file_remote) { // !files_remote.includes(file.name)

					let upload_or_not = true;

					if (overwrite_if_newer) {
						upload_or_not = false;
						let stats = fs.statSync(dir + file.name);
						//console.log(stats);

						if (undefined === file_remote || new Date(stats.mtime) > new Date(file_remote.mtime)) {
							console.log('MODIFIED!', file.name);
							upload_or_not = true;
						}
					}

					//console.log('queue_files');
					if (upload_or_not)
						this.queue_files.add(async () => {
							//console.log('upload', dir + file.name, prefix + file.name);
							await this.upload(dir + file.name, prefix + file.name, acl);

							// if dir queue have been paused - unpausing if files queue became smaller
							if (this.queue_dirs.isPaused && 3 * this.files_concurrency > this.queue_files.size) {
								this.queue_dirs.start();
								console.log('UNpausing dir queue');
							}


						}, {priority : 1}); // maximum priority for file uploads
				}
			}
		}
		
		// if files queue 3 times bigger than in settings - pausing dirs queue so it wont eat too much memory
		console.log(this.queue_files.size);
		if (3 * this.files_concurrency < this.queue_files.size) {
			this.queue_dirs.pause();
			console.log('Pausing dir queue');
		}

		//console.log('AFTER FOR queue_files.size', this.queue_files.size);
		return true;
	}





	/**
	 * Uploads a directory from a cloud to cloud (using current temp dir as intermediary), skips empty dirs
	 * @param {Object} CONF - Configuration for the another S3 connection.
	 * @param {string} dir - Local directory path to upload.
	 * @param {string} [prefix=''] - Prefix to add to S3 object keys.
	 * @param {Object} [params={}] - Additional parameters for customization.
	 * @param {string} [params.acl=public-read] - Access control list. Default is "public-read."
	 * @param {boolean} [params.overwrite=false] - Whether to overwrite existing items. Default is "false"
	 * @param {boolean} [params.overwrite_if_newer=false] - Overwrite only if the source is newer. Default is "false"
	 * @param {number} [params.dirs_concurrency] - Number of concurrent directories operations.
	 * @param {number} [params.files_concurrency] - Number of concurrent files operations.
	 * @returns {Promise<boolean>} - A promise resolving to true if the upload is successful.
	 */
	async uploadDirCloud(CONF, dir, prefix = '', params = {}) {
		console.log('uploadDir', dir, prefix);

		const remote_from = new (require('./'));
		remote_from.config(CONF);
		//await remote_from.download('/fc42b21790b0dd77e26b.js', '/var/folders/rr/q_0tgkkn4299bwpz8xsl17m00000gn/T/fc42b21790b0dd77e26b.js');
		//console.log(remote_from);

		let
			overwrite = false,
			overwrite_if_newer = false,
			acl = 'public-read';

		if ('acl' in params && params.acl) {
			acl = params.acl;
		}
		if ('overwrite' in params && params.overwrite) {
			overwrite = true;
		}
		if ('overwrite_if_newer' in params && params.overwrite_if_newer) {
			overwrite = true;
			overwrite_if_newer = true;
		}

		// making sure queues initiated (or settings passed about changing concurrecy, so we reinitiate queues)
		if (null === this.queue_dirs || 'dirs_concurrency' in params) {
			this.queue_dirs = new PQueue({concurrency: ('dirs_concurrency' in params) ? params.dirs_concurrency : this.dirs_concurrency});
			delete params.dirs_concurrency;
		}
		if (null === this.queue_files || 'files_concurrency' in params) {
			this.queue_files = new PQueue({concurrency: ('files_concurrency' in params) ? params.files_concurrency : this.files_concurrency});
			delete params.files_concurrency;
		}

		//for (let i = 0; i <= 20; i++) this.upload('./test-files/test copy 85.js', 'lambda8/test copy 85.js').then(console.log); return;

		// adding trailing slash to add deeper path in the future
		if (!dir.endsWith('/') && '' != dir) dir += '/';
		// Removing the first slash, if it exists
		prefix = prefix.replace(/^\//, '');

		let files_remote = await this.list(prefix, true);
		//let files = fs.readdirSync(dir, { withFileTypes: true });
		let files = await remote_from.list(dir, true);
		console.log(files_remote);

		//console.log(files_remote);
		//console.log('filling files/dir queue');

		for (let file of files) {

			if (file.is_dir) {
				//console.log('uploadDir', dir, file.name, prefix, file.name);
				this.queue_dirs.add(() => {
					return this.uploadDirCloud(CONF, dir + file.name, prefix + file.name + '/', params);
				}, {priority : 0});

			} else {

				// Searching for remote file in array
				let file_remote = files_remote.find(obj => {
				 	return file.name === obj.name
				});

				if (overwrite || undefined === file_remote) { // !files_remote.includes(file.name)

					let upload_or_not = true;

					if (overwrite_if_newer) {
						upload_or_not = false;
						//let stats = fs.statSync(dir + file.name);
						//console.log(stats);
						console.log(file_remote);
						if (undefined === file_remote || new Date(file.mtime) > new Date(file_remote.mtime)) {
							console.log('MODIFIED!', file.name);
							upload_or_not = true;
						}
					}

					//console.log('queue_files');
					if (upload_or_not)
						this.queue_files.add(async () => {
							console.log('upload', dir + file.name, prefix + file.name);

							console.log('download', dir + file.name, os.tmpdir() + '/' + file.name);
							await remote_from.download(dir + file.name, os.tmpdir() + '/' + file.name);

							if (!fs.existsSync(os.tmpdir() + '/' + file.name)) {
								throw new Error('NO FILE ' + dir + file.name + ' ' + os.tmpdir() + '/' + file.name);
							}
							console.log('downloaded');

							await this.upload(os.tmpdir() + '/' + file.name, prefix + file.name, acl);
							console.log('uploaded');
							fs.unlinkSync(os.tmpdir() + '/' + file.name);

							// if dir queue have been paused - unpausing if files queue became smaller
							if (this.queue_dirs.isPaused && 3 * this.files_concurrency > this.queue_files.size) {
								this.queue_dirs.start();
								console.log('UNpausing dir queue');
							}


						}, {priority : 1}); // maximum priority for file uploads
				}
			}
		}
		
		// If files queue 3 times bigger than in settings - pausing dirs queue so it wont eat too much memory
		console.log(this.queue_files.size);
		if (3 * this.files_concurrency < this.queue_files.size) {
			this.queue_dirs.pause();
			console.log('Pausing dir queue');
		}

		//console.log('AFTER FOR queue_files.size', this.queue_files.size);
		return true;
	}



	/**
	 * Downloads a directory from S3, including subdirectories and files, skips empty dirs
	 * Can handle subdirectories, overwrite existing files, and check for modifications
	 * @param {string} [prefix=''] - Prefix of S3 object keys to download.
	 * @param {string} dir - Local directory path to save downloaded files.
	 * @param {Object} [params={}] - Additional parameters for customization.
	 * @param {string} [params.acl=public-read] - Access control list. Default is "public-read."
	 * @param {boolean} [params.overwrite=false] - Whether to overwrite existing items. Default is "false"
	 * @param {boolean} [params.overwrite_if_newer=false] - Overwrite only if the source is newer. Default is "false"
	 * @param {number} [params.dirs_concurrency] - Number of concurrent directories operations.
	 * @param {number} [params.files_concurrency] - Number of concurrent files operations.
	 * @returns {Promise<boolean>} - A promise resolving to true if the download is successful.
	 */
	async downloadDir(prefix = '', dir, params = {}) {
		console.log('downloadDir', dir, prefix);

		fs.mkdirSync(dir, { recursive: true });

		let
			overwrite = false,
			overwrite_if_newer = false,
			acl = 'public-read';

		if ('acl' in params && params.acl) {
			acl = params.acl;
		}
		if ('overwrite' in params && params.overwrite) {
			overwrite = true;
		}
		if ('overwrite_if_newer' in params && params.overwrite_if_newer) {
			overwrite = true;
			overwrite_if_newer = true;
		}

		// Making sure queues initiated (or settings passed about changing concurrecy, so we reinitiate queues)
		if (null === this.queue_dirs || 'dirs_concurrency' in params) {
			this.queue_dirs = new PQueue({concurrency: ('dirs_concurrency' in params) ? params.dirs_concurrency : this.dirs_concurrency});
			delete params.dirs_concurrency;
		}
		if (null === this.queue_files || 'files_concurrency' in params) {
			this.queue_files = new PQueue({concurrency: ('files_concurrency' in params) ? params.files_concurrency : this.files_concurrency});
			delete params.files_concurrency;
		}

		// Adding trailing slash to add deeper path in the future
		if (!dir.endsWith('/') && '' != dir) dir += '/';
		// removing first slash, if exists
		prefix = prefix.replace(/^\//, '');

		let files = await this.list(prefix, true);

		//console.log(files_remote);
		//console.log('filling files/dir queue');

		for (let file of files) {

			if (file.is_dir) {
				//console.log('uploadDir', dir, file.name, prefix, file.name);

				this.queue_dirs.add(() => {
					return this.downloadDir(prefix + file.name + '/', dir + file.name, params);
				}, {priority : 0});

			} else {
				let local_file_exists = fs.existsSync(dir + '/' + file.name);

				if (overwrite || !local_file_exists) { // !files_remote.includes(file.name)

					let upload_or_not = true;

					if (overwrite_if_newer) {
						upload_or_not = false;

						let stats;
						if (!local_file_exists) {
							stats = fs.statSync(dir + file.name);
						}
						//console.log(stats);

						if (!local_file_exists || new Date(file.mtime) > new Date(stats.mtime)) {
							console.log('MODIFIED!', file.name);
							upload_or_not = true;
						}
					}

					//console.log('queue_files');
					if (upload_or_not)
						this.queue_files.add(async () => {
							//console.log(os.tmpdir());
							console.log('download', prefix + file.name, dir + '/' + file.name);
							await this.download(prefix + file.name, dir + '/' + file.name);

							if (!fs.existsSync(dir + '/' + file.name)) {
								throw new Error('NO FILE ' + prefix + file.name + ' ' + dir + '/' + file.name);
							}

							// if dir queue have been paused - unpausing if files queue became smaller
							if (this.queue_dirs.isPaused && 3 * this.files_concurrency > this.queue_files.size) {
								this.queue_dirs.start();
								console.log('UNpausing dir queue');
							}

						}, {priority : 1}); // Maximum priority for file uploads
				}
			}
		}
		
		// if files queue 3 times bigger than in settings - pausing dirs queue so it wont eat too much memory
		console.log(this.queue_files.size);
		if (3 * this.files_concurrency < this.queue_files.size) {
			this.queue_dirs.pause();
			console.log('Pausing dir queue');
		}

		//console.log('AFTER FOR queue_files.size', this.queue_files.size);
		return true;
	}






	/**
	 * Uploads a directory to S3, including subdirectories and files, skips empty dirs, slower version, waits till all files in dir will be uploaded and then goes to next dir
	 * Skips empty directories and follows a slower version that waits until
	 * all files in a directory are uploaded before proceeding to the next directory.
	 * @param {string} dir - Local directory path to upload.
	 * @param {string} [prefix=''] - Prefix to add to S3 object keys.
	 * @param {string} [acl='public-read'] - ACL (Access Control List) for the uploaded objects.
	 * @param {boolean} [overwrite=false] - Flag to overwrite existing files in S3.
	 * @returns {Promise<boolean>} - A promise resolving to true if the upload is successful.
	 */
	async uploadDir2(dir, prefix = '', acl = 'public-read', overwrite = false) {
		console.log('uploadDir', dir, prefix);

		//for (let i = 0; i <= 20; i++) this.upload('./test-files/test copy 85.js', 'lambda8/test copy 85.js').then(console.log); return;

		if (null === this.queue) {
			this.queue = new PQueue({concurrency: 1});
		}

		// adding trailing slash to add deeper path in the future
		if (!dir.endsWith('/')) dir += '/';
		// removing first slash, if exists
		prefix = prefix.replace(/^\//, '');

		let files_remote = await this.list(prefix);
		let files = fs.readdirSync(dir, { withFileTypes: true });

		let queue_files = new PQueue({concurrency: 50});
		let queue_files_filled = false;


		//console.log(files_remote);
		//console.log('filling files/dir queue');

		for (let file of files) {

			if (file.isDirectory()) {
				//console.log('uploadDir', dir, file.name, prefix, file.name);

				this.queue.add(() => {
					return this.uploadDir2(dir + file.name, prefix + file.name + '/', acl, overwrite);
				}, {priority : 0});

			} else {
				if (overwrite || !files_remote.includes(file.name)) {

					//console.log('queue_files');
					queue_files.add(() => {
						//console.log('upload', dir + file.name, prefix + file.name);
						return this.upload(dir + file.name, prefix + file.name, acl);
					}, {priority : 1}); // maximum priority for file uploads
				}
			}
		}
		
		queue_files_filled = true;

		//console.log('AFTER FOR queue_files.size', queue_files.size);
		//var self = this;

		return new Promise((resolve, reject) => {

			// waiting for files queue to be filled (if any files exists)
			let interval = setInterval(async () => {
				//console.log('interval')

				if (queue_files_filled) {
					//console.log('queue_files_filled = true, queue_files.size=', queue_files.size);
					clearInterval(interval);

					// waiting for files queue to be finished (::TRICKY:: if its 0 in queue it will trigger immediately)
					await queue_files.onIdle();

					//console.log('uploadDir finished', dir, 'dir queue size=', self.queue.size, self.queue.pending);

					resolve();
				}

			}, 1000);

		});
	}

	/**
	 * Uploads a file to S3, automatically creates directory if not exists
	 * @param {string} from - Local file path to upload.
	 * @param {string} to - S3 object key.
	 * @param {string} [acl='public-read'] - ACL (Access Control List) for the uploaded object.
	 * @returns {Promise} - A promise resolving when the upload is complete.
	 */
	async upload(from, to, acl = 'public-read', attempt = 0, cb) {
		if (attempt) console.log(attempt);
	    let self = this;

		// getting mime
		// mimetypes good only with files with extension
		let mime = mimetypes.lookup(from);

		if (!mime) {
			// this one works for images and videos but not on .js/.json etc
			let res = await fileTypeFromFile(from);

			if (res) {
				mime = res.mime;
			} else {
				// getting mime from file extension (for .svg etc)
				mime = mimetypes.contentType(to.slice(-5))
			}
		}
		//console.log('file\'s mime', mime);

	    const readStream = fs.createReadStream(from);
	    const params = {
	        Bucket: this.bucket,
	        Key: to,
	        Body: readStream,
	        ACL : acl, // remove if should be private
	    };
	    if (mime) {
	    	params.ContentType = mime;
	    }


	    return new Promise((resolve, reject) => {
	        this.s3.upload(params, async function (err, data) {
	            readStream.destroy();
	            if (err) {
	            	//console.log('err code:', err.code, 'err:', err, 'data:', data);

	            	console.log('retrying upload');

	            	if ('SlowDown' == err.code || 503 == err.statusCode) {
	            		console.log('Received SlowDown error. Retrying in 1 sec...');

	            		setTimeout(() => {

	            			self.upload(from, to, acl, ++attempt, resolve);
	            			

	            		}, 1000);
	            	} else {
	            		if (3 > attempt) {
	            			console.log('after trying 3 times upload failed', err);
	            			reject(false);
	            		} else {
	            			this.upload(from, to, acl, ++attempt, resolve);
	            		}
	            	}

	            	//resolve(data);
	                //return reject(err);
	            } else {
	            	if ('function' == typeof cb) cb(data);
	           		resolve(data);
	            }
	        });
	    });
	}

	/**
	 * Downloads a file from S3. If success: returns downloaded file path, if fails: FALSE
	 * @param {string} from - S3 object key to download.
	 * @param {string} to - Local file path to save the downloaded file.
	 * @returns {Promise<string|boolean>} - A promise resolving to the local file path if successful, or false on failure.
	 */
	download(from, to) {

	    const params = {
	        Bucket: this.bucket,
	        Key: from,
	    };
	    return new Promise((resolve, reject) => {
	        this.s3.getObject(params, function (err, data) {
	            if (err) {
	                return reject(false);// reject(err);
	            } else {
	            	fs.writeFileSync(to, data.Body);
	            }
	            return resolve(to);
	        });
	    });
	}

	// rm
	/**
	 * Deletes a file from S3.
	 * @param {string} file - S3 object key to delete.
	 * @returns {Promise<string|boolean>} - A promise resolving to the deleted object key if successful, or false on failure.
	 */
	delete(path, attempt = 0) {

	    let self = this;

	    const params = {
	        Bucket: this.bucket,
	        Key: path,
	    };
	    return new Promise((resolve, reject) => {
			this.s3.deleteObject(params, function(err, data) {
				if (err) {
					console.log(err, err.stack);  // error

	            	if ('SlowDown' == err.code || 503 == err.statusCode) {
	            		console.log('Received SlowDown error. Retrying in 2 sec...');

	            		setTimeout(() => {

	            			resolve(self.delete(path, ++attempt));
	        
	            		}, 2000);
	            	} else {
	            		if (13 > attempt) {
	            			console.log('after trying 13 times "delete" failed', err);
	            			reject(false);
	            		} else {
	            			resolve(this.delete(path, ++attempt));
	            		}
	            	}

					//return resolve(false);
				} else {
					return resolve(path);
				}
			});
	    });
	}


	/**
	 * Deletes all objects in a specified directory from S3.
	 * @param {string} path - S3 directory path to delete.
	 * @returns {Promise<Array>} - A promise resolving to an array of results for each deleted object.
	 */
	async deleteDir(path) {
		let files = await this.list(path);

		// adding slash in the end if dont have
		if ('/' != path.slice(-1)) {
			path += '/';
		}

		let promises = [];
		for (let file of files) {
			console.log('Removing', path + file);
			promises.push(this.delete(path + file));
		}

		return Promise.allSettled(promises);
	}



	// ls
	/**
	 * Lists objects in a specified S3 directory, by default only file names array without metadata
	 * @param {string} path - S3 directory path to list.
	 * @param {boolean} [full_data=false] - Flag to include full metadata for each object.
	 * @returns {Promise<Array|string>} - A promise resolving to an array of object keys or full metadata objects.
	 */
	list(path, full_data = false) {

		// adding slash in the end if missing
		path = path.replace(/\/?$/, '/');
		// if root path - removing / so it will work
		if ('/' == path) path = '';

		let params = {
			Bucket: this.bucket,
			Delimiter: '/',
			Prefix: path,
			//MaxKeys: 2,
		};

		return this.listAllKeys(params, [], full_data);
	} 

	/**
	 * Retrieves metadata for a specified S3 object.
	 * @param {string} key - S3 object key for which to retrieve metadata.
	 * @returns {Promise<Object>} - A promise resolving to the metadata object for the specified S3 object.
	 */
	async getMetaData(key) {

		const params = {
			Bucket: this.bucket,
			Key: key,
		}
		const metaData = await this.s3.headObject(params).promise();
		console.log(metaData);

		return metaData;
	}


	// PRIVATE

	listAllKeys(params, out = [], full_data = false) {
		return new Promise((resolve, reject) => {
		  this.s3.listObjectsV2(params).promise()
		    .then(({Contents, CommonPrefixes, IsTruncated, NextContinuationToken}) => {
		    	//console.log('CommonPrefixes', CommonPrefixes);

		    	// thats for directories
				for (let el of CommonPrefixes) {
					// removing prefix from the name
					let name = el.Prefix.replace( new RegExp('^(' + params.Prefix + ')', 'g'), '');
					// removing slash in the end
					name = name.replace(/\/$/, '');

					if (full_data) {
						out.push({
							is_dir : true,
							name : name,
						});
					} else {
						out.push(name);
					}
				}
				// thats for files
				//console.log(Contents);
				for (let el of Contents) {
					//let name = el.Key.replace(params.Prefix, '');

					// removing prefix from the name
					let name = el.Key.replace( new RegExp('^(' + params.Prefix + ')', 'g'), '');

					// if directory is empty it will be empty name, not adding
					if (name) {
						if (full_data) {
							out.push({
								is_dir : false,
								name : name,
								mtime : el.LastModified,
								size : el.Size,
								//etag : el.ETag,
								//StorageClass : el.StorageClass,
							});
						} else {
							out.push(name);
						}
					}
				}

				//return resolve(out);
		    	//out.push(...Contents);
		    	!IsTruncated ? resolve(out) : resolve(this.listAllKeys(Object.assign(params, {ContinuationToken: NextContinuationToken}), out, full_data));
		    })
		    .catch((err) => {
	        	if ('SlowDown' == err.code || 503 == err.statusCode) {
	        		console.log('Received SlowDown error. Retrying in 1 sec...');

	        		setTimeout(() => {
		    			resolve(this.listAllKeys(params, out, full_data));
	        		}, 1000);
	        	} else {
	        		reject(err);
	        	}

		    	console.log('ERROR', err);
		    });
		});

	} 
}




