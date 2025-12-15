const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs').promises;
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY;

// API Key authentication middleware
const requireApiKey = (req, res, next) => {
  const providedKey = req.headers['x-api-key'] || req.query.api_key;

  if (!API_KEY) {
    return res.status(500).json({ error: 'API key not configured on server' });
  }

  if (providedKey !== API_KEY) {
    return res.status(401).json({ error: 'Invalid or missing API key' });
  }

  next();
};

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Apply API key middleware to all routes except health check
app.use((req, res, next) => {
  if (req.path === '/health') {
    return next();
  }
  return requireApiKey(req, res, next);
});

// Create downloads directory if it doesn't exist
const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
fs.mkdir(DOWNLOADS_DIR, { recursive: true });

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'yt-dlp worker is running' });
});

// Get video info endpoint
app.post('/info', async (req, res) => {
  try {
    const { url, cookies, cookiesContent } = req.body;

    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }

    // Build command with optional cookies
    let command = `yt-dlp --js-runtimes deno --dump-json "${url}"`;
    let tempCookiesFile = null;

    if (cookiesContent) {
      // Create temporary cookies file from content
      tempCookiesFile = path.join(DOWNLOADS_DIR, `temp_cookies_${Date.now()}.txt`);
      await fs.writeFile(tempCookiesFile, cookiesContent);
      command += ` --cookies "${tempCookiesFile}"`;
    } else if (cookies) {
      // Use cookies file path
      command += ` --cookies "${cookies}"`;
    }

    const { stdout } = await execAsync(command);
    const info = JSON.parse(stdout);

    // Clean up temporary cookies file if created
    if (tempCookiesFile) {
      try {
        await fs.unlink(tempCookiesFile);
      } catch (cleanupError) {
        console.warn('Failed to cleanup temporary cookies file:', cleanupError);
      }
    }

    res.json({
      title: info.title,
      duration: info.duration,
      uploader: info.uploader,
      view_count: info.view_count,
      like_count: info.like_count,
      thumbnail: info.thumbnail,
      formats: info.formats.map(format => ({
        format_id: format.format_id,
        ext: format.ext,
        resolution: format.resolution,
        fps: format.fps,
        filesize: format.filesize,
        vcodec: format.vcodec,
        acodec: format.acodec
      }))
    });
  } catch (error) {
    console.error('Error getting video info:', error);
    res.status(500).json({ error: 'Failed to get video info', details: error.message });
  }
});

// Download video endpoint
app.post('/download', async (req, res) => {
  try {
    const { url, format = 'best', filename, cookies, cookiesContent } = req.body;

    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }

    const outputFilename = filename || `%(title)s.%(ext)s`;
    const outputPath = path.join(DOWNLOADS_DIR, outputFilename);

    // Handle cookies - either from content or file path
    let tempCookiesFile = null;
    let cookiesFile = cookies;

    if (cookiesContent) {
      // Create temporary cookies file from content
      tempCookiesFile = path.join(DOWNLOADS_DIR, `temp_cookies_${Date.now()}.txt`);
      await fs.writeFile(tempCookiesFile, cookiesContent);
      cookiesFile = tempCookiesFile;
    }

    // Build command with optional cookies
    let command = `yt-dlp --js-runtimes deno -f "${format}" -o "${outputPath}"`;
    if (cookiesFile) {
      command += ` --cookies "${cookiesFile}"`;
    }
    command += ` "${url}"`;

    // Execute the download
    await execAsync(command);

    // Get the actual filename (yt-dlp substitutes template variables)
    let infoCommand = `yt-dlp --js-runtimes deno --dump-json "${url}"`;
    if (cookiesFile) {
      infoCommand += ` --cookies "${cookiesFile}"`;
    }

    const { stdout } = await execAsync(infoCommand);
    const info = JSON.parse(stdout);
    const actualFilename = `${info.title}.${info.ext}`;
    const filePath = path.join(DOWNLOADS_DIR, actualFilename);

    // Clean up temporary cookies file if created
    if (tempCookiesFile) {
      try {
        await fs.unlink(tempCookiesFile);
      } catch (cleanupError) {
        console.warn('Failed to cleanup temporary cookies file:', cleanupError);
      }
    }

    // Check if file exists
    try {
      await fs.access(filePath);
      res.json({
        success: true,
        message: 'Download completed',
        filename: actualFilename,
        path: filePath
      });
    } catch (error) {
      res.json({
        success: true,
        message: 'Download completed (file path may differ)',
        outputPath: outputPath
      });
    }

  } catch (error) {
    console.error('Error downloading video:', error);
    res.status(500).json({ error: 'Failed to download video', details: error.message });
  }
});

// List downloaded files endpoint
app.get('/downloads', async (req, res) => {
  try {
    const files = await fs.readdir(DOWNLOADS_DIR);
    const fileList = [];

    for (const file of files) {
      const filePath = path.join(DOWNLOADS_DIR, file);
      const stats = await fs.stat(filePath);

      if (stats.isFile()) {
        fileList.push({
          name: file,
          size: stats.size,
          created: stats.birthtime,
          modified: stats.mtime
        });
      }
    }

    res.json({ files: fileList });
  } catch (error) {
    console.error('Error listing downloads:', error);
    res.status(500).json({ error: 'Failed to list downloads' });
  }
});

// Serve downloaded files
app.get('/downloads/:filename', async (req, res) => {
  try {
    const filename = req.params.filename;
    const filePath = path.join(DOWNLOADS_DIR, filename);

    // Check if file exists
    await fs.access(filePath);

    res.download(filePath, filename);
  } catch (error) {
    console.error('Error serving file:', error);
    res.status(404).json({ error: 'File not found' });
  }
});

// Delete downloaded file
app.delete('/downloads/:filename', async (req, res) => {
  try {
    const filename = req.params.filename;
    const filePath = path.join(DOWNLOADS_DIR, filename);

    await fs.unlink(filePath);

    res.json({ message: 'File deleted successfully' });
  } catch (error) {
    console.error('Error deleting file:', error);
    res.status(404).json({ error: 'File not found or could not be deleted' });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong!' });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

app.listen(PORT, () => {
  console.log(`yt-dlp worker running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`Downloads directory: ${DOWNLOADS_DIR}`);
});