# Simple driver for AWS S3 compatible storage

This Node.js module provides a flexible AWS S3 driver for handling file uploads, downloads, and directory operations. It is designed to work with the [AWS SDK](https://aws.amazon.com/sdk-for-node-js/) and includes features for managing concurrency, uploading directories, and more.

# Features

* Upload: Upload files and directories to AWS S3.
* Download: Download files and directories from AWS S3.
* Delete: Delete files and directories from AWS S3.
* List: List objects in an S3 directory with optional metadata.

# Installation

```
git clone https://github.com/TheGP/s3driver
cd s3driver
npm install
```

# Example
```
const 
	remote = require('./s3driver'),

remote.config({
    accessKeyId: 'AWG7P3D8VX5Z9F21L6QC',
    secretAccessKey: 'sX9KpR4HjQ8UyL3oB6ZvA2DcP1F5TtG7IiJ2R8JqD3L4O9P2L7E8',
    endpoint: 'https://ams3.digitaloceanspaces.com',
    bucket: 'bucket-name',
});

console.log(await remote.list(dir));
```

# Methods

- **`config(config)`:**
    - Configures the S3 driver with AWS credentials and bucket information.
    
- **`uploadDir(dir, prefix = '', params = {})`:**
    - Asynchronously uploads a local directory to S3.
    - Can handle subdirectories, overwrite existing files, and check for modifications.

	 * @param {string} dir - Local directory path to upload.
	 * @param {string} [prefix=''] - Prefix to add to S3 object keys.
	 * @param {Object} [params={}] - Additional parameters for customization.
	 * @returns {Promise<boolean>} - A promise resolving to true if the upload is successful.

- **`uploadDirCloud(CONF, dir, prefix = '', params = {})`:**
    - Uploads a directory from one S3 bucket to another.

	 * @param {Object} CONF - Configuration for the another AWS S3 connection.
	 * @param {string} dir - Local directory path to upload.
	 * @param {string} [prefix=''] - Prefix to add to S3 object keys.
	 * @param {Object} [params={}] - Additional parameters for customization.
	 * @returns {Promise<boolean>} - A promise resolving to true if the upload is successful.

- **`downloadDir(prefix = '', dir, params = {})`:**
    - Asynchronously downloads a directory from S3 to a local path.
    - Can handle subdirectories, overwrite existing files, and check for modifications.

	 * @param {string} [prefix=''] - Prefix of S3 object keys to download.
	 * @param {string} dir - Local directory path to save downloaded files.
	 * @param {Object} [params={}] - Additional parameters for customization.
	 * @returns {Promise<boolean>} - A promise resolving to true if the download is successful.

- **`list(prefix = '', is_dir = false)`:**
    - Lists objects in an S3 bucket with a given prefix.
	 * @param {string} path - S3 directory path to list.
	 * @param {boolean} [full_data=false] - Flag to include full metadata for each object.
	 * @returns {Promise<Array|string>} - A promise resolving to an array of object keys or full metadata objects.

    
- **`upload(localPath, s3Path, acl = 'public-read')`:**
    - Uploads a single file to S3.

	 * @param {string} from - Local file path to upload.
	 * @param {string} to - S3 object key.
	 * @param {string} [acl='public-read'] - ACL (Access Control List) for the uploaded object.
	 * @returns {Promise} - A promise resolving when the upload is complete.

- **`download(s3Path, localPath)`:**
    - Downloads a single file from S3.

	 * @param {string} from - S3 object key to download.
	 * @param {string} to - Local file path to save the downloaded file.
	 * @returns {Promise<string|boolean>} - A promise resolving to the local file path if successful, or false on failure.

- **`delete(s3Path)`:**
    - Deletes a file from AWS S3.
	 * @param {string} file - S3 object key to delete.
	 * @returns {Promise<string|boolean>} - A promise resolving to the deleted object key if successful, or false on failure.

- **`deleteDir(s3Path)`:**
    - Deletes all objects in a specified directory from AWS S3.
	 * @param {string} path - S3 directory path to delete.
	 * @returns {Promise<Array>} - A promise resolving to an array of results for each deleted object.

- **`list(s3Path)`:**
    - Lists objects in a specified S3 directory, by default only file names array without metadata
	 * @param {string} path - S3 directory path to list.
	 * @param {boolean} [full_data=false] - Flag to include full metadata for each object.
	 * @returns {Promise<Array|string>} - A promise resolving to an array of object keys or full metadata objects.

- **`getMetaData(s3Path)`:**
    - Retrieves metadata for a specified S3 object.
	 * @param {string} key - S3 object key for which to retrieve metadata.
	 * @returns {Promise<Object>} - A promise resolving to the metadata object for the specified S3 object.
