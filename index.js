const promisify = require('promisify-node')
const fs = promisify('fs')
const rimraf = promisify('rimraf')
const checksum = require('checksum')
const path = require('path')
const http = require('http')
const mime = require('mime-types')
const nodeUrl = require('url')

module.exports = options => async (files, metalsmith, done) =>  {
	try {
		// Default options
		options = Object.assign(
			{
				temp        : `.metalsmith-download-external-assets-${(Math.random() * 100000000).toFixed(0)}`,
				destination : 'external-assets',
				clearTemp   : true
			},
			options
		)

		// Create a fresh temp directory
		if(options.clearTemp) {
			await rimraf(options.temp)
		}
		try {
			await fs.mkdir(options.temp)
		}
		catch(error) {}

		// Extract all the urls to be downloaded
		const urlMap = Object.keys(files)
		.filter(isSource)
		.reduce((urlMap, file) => {
			let contents = files[file].contents.toString()
			let match
			const re = /download::(.*?)::download/g
			do {
				match = re.exec(contents)
				if (match) {
					const url = match[1].indexOf('//') === 0 ? `http:${match[1]}` : match[1]
					if(typeof urlMap[match[0]] === 'undefined'){
						urlMap[match[0]] = url
					}
				}
			} while (match)
			return urlMap
		}, {})

		// Download and pipe the files
		const results = await Promise.all(Object.keys(urlMap).map(id =>
			cacheFile(id, urlMap[id], options.temp, options.destination, files)
		))

		// Replace all the external urls with the local ones
		Object.keys(files)
		.filter(isSource)
		.forEach(file => {
			let contents = files[file].contents.toString()
			results.forEach(result => {
				const re = new RegExp(escape(result.id), 'g')
				contents = contents.replace(re, result.localUrl)
			})
			files[file].contents = contents
		})

		// Clear the temp directory
		if(options.clearTemp) {
			await rimraf(options.temp)
		}

		done()
	}
	catch (error) {
		done(error)
	}
}

const cacheFile = async (id, url, tempDirectory, destDirectory, files) => {
	// Compute hash of the file based on the url
	const hash = checksum(url)

	// check if the file was already downloaded previously
	let dir = await fs.readdir(tempDirectory)
	let localUrl
	dir = dir.filter(file => file.indexOf(hash) === 0)
	if(dir.length === 1){
		// File exists!
		localUrl = `${destDirectory}/${dir[0]}`
	}
	else {
		// download the file to a temporary location
		const tempPath = path.join(tempDirectory, hash)
		const response = await download(url, tempPath)
		// rename the file adding the extensions
		const newFilename = `${hash}.${mime.extension(response.headers['content-type'])}`
		const renamedPath = path.join(tempDirectory, newFilename)
		await fs.rename(tempPath, renamedPath)
		// pipe the file out to the destination
		const finalPath = path.join( destDirectory, newFilename)
		const buffer = await fs.readFile(renamedPath)
		files[finalPath] = {}
		files[finalPath].contents = buffer

		localUrl = `${destDirectory}/${newFilename}`
	}

	// Return an object with the id and the localUrl
	return {
		id,
		localUrl
	}
}

const download = (url, dest) => new Promise((resolve, reject) => {
	const file = fs.createWriteStream(dest)
	const request = http.get(url, function(response) {
		if (response.statusCode !== 200) {
			return reject('Response status was ' + response.statusCode);
		}
		response.pipe(file)
		file.on('finish', function() {
			file.close(resolve(response))
		})
	})

	request.on('error', function (err) {
		fs.unlink(dest)
		return reject(err.message)
	})

	file.on('error', function(err) {
		fs.unlink(dest)
		return reject(err.message)
	})
})
const escape = s => s.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')
const isSource = file => /\.(htm|html|js|css)/.test(path.extname(file))