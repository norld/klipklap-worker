// Load environment variables from .env file
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs').promises;
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

const app = express();
const PORT = process.env.PORT || 3002;
const API_KEY = process.env.API_KEY;

// Trust proxy - required for Cloudflare/other reverse proxies
app.set('trust proxy', true);

// API Key authentication middleware
const requireApiKey = (req, res, next) => {
  // Check multiple header sources for Cloudflare compatibility
  const providedKey = req.headers['x-api-key'] ||
                       req.headers['x-api-key'.toLowerCase()] ||
                       req.query.api_key;

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

// Logging middleware
app.use((req, res, next) => {
  console.log(`${req.method} ${req.path} - IP: ${req.ip}`);
  next();
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    service: 'yt-dlp-worker',
    version: '1.0.0',
    status: 'running',
    features: {
      browserCookies: {
        enabled: true,
        forced: true,
        defaultBrowser: 'chromium',
        supportedBrowsers: ['chrome', 'chromium', 'firefox', 'safari', 'edge', 'opera', 'brave', 'vivaldi'],
        fallbackOrder: [
          '1. Browser cookies (chromium by default)',
          '2. Explicit cookies file/content (if provided)',
          '3. Android client (no cookies)'
        ]
      }
    },
    endpoints: {
      health: 'GET /health',
      info: 'POST /info - Body: { url, browser?, cookies?, cookiesContent? }',
      download: 'POST /download - Body: { url, format?, filename?, browser?, cookies?, cookiesContent? }',
      downloads: 'GET /downloads',
      downloadFile: 'GET /downloads/:filename',
      deleteFile: 'DELETE /downloads/:filename'
    },
    examples: {
      infoWithDefaultBrowser: {
        method: 'POST',
        url: '/info',
        body: { url: 'https://www.youtube.com/watch?v=xxx' },
        note: 'Always tries Chromium cookies first'
      },
      infoWithSpecificBrowser: {
        method: 'POST',
        url: '/info',
        body: { url: 'https://www.youtube.com/watch?v=xxx', browser: 'chrome' }
      }
    }
  });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'yt-dlp worker is running' });
});

// Get video info endpoint
app.post('/info', async (req, res) => {
  let tempCookiesFile = null;

  try {
    const { url, cookies, cookiesContent, browser } = req.body;

    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }

    let info;
    const browserName = browser || 'chromium';  // Default to chromium

    // Helper function to clean up temp cookies file
    const cleanup = async () => {
      if (tempCookiesFile) {
        try {
          await fs.unlink(tempCookiesFile);
        } catch (cleanupError) {
          console.warn('Failed to cleanup temporary cookies file:', cleanupError);
        }
      }
    };

    // ALWAYS try browser cookies first, then fall back to explicit cookies, then android client
    console.log(`Step 1: Trying browser cookies (${browserName})...`);

    try {
      const command = `yt-dlp --dump-json --skip-download --cookies-from-browser ${browserName} "${url}"`;
      console.log(`Command: ${command}`);
      const { stdout } = await execAsync(command);
      info = JSON.parse(stdout);
      console.log(`✓ Browser cookies succeeded!`);
    } catch (browserError) {
      console.log(`✗ Browser cookies failed: ${browserError.message}`);

      // Try explicit cookies if provided
      if (cookiesContent || cookies) {
        console.log(`Step 2: Trying explicit cookies...`);

        try {
          let command;
          if (cookiesContent) {
            tempCookiesFile = path.join(DOWNLOADS_DIR, `temp_cookies_${Date.now()}.txt`);
            await fs.writeFile(tempCookiesFile, cookiesContent);
            command = `yt-dlp --dump-json --skip-download "${url}" --cookies "${tempCookiesFile}"`;
          } else {
            command = `yt-dlp --dump-json --skip-download "${url}" --cookies "${cookies}"`;
          }

          console.log(`Command: ${command}`);
          const { stdout } = await execAsync(command);
          info = JSON.parse(stdout);
          console.log(`✓ Explicit cookies succeeded!`);
          await cleanup();
        } catch (cookiesError) {
          console.log(`✗ Explicit cookies failed: ${cookiesError.message}`);
          await cleanup();

          // Fall back to android client
          console.log(`Step 3: Falling back to android client...`);
          const command = `yt-dlp --dump-json --extractor-args "youtube:player_client=android" "${url}"`;
          console.log(`Command: ${command}`);
          const { stdout } = await execAsync(command);
          info = JSON.parse(stdout);
          console.log(`✓ Android client succeeded!`);
        }
      } else {
        // No explicit cookies, go straight to android client
        console.log(`Step 2: Falling back to android client...`);
        const command = `yt-dlp --dump-json --extractor-args "youtube:player_client=android" "${url}"`;
        console.log(`Command: ${command}`);
        const { stdout } = await execAsync(command);
        info = JSON.parse(stdout);
        console.log(`✓ Android client succeeded!`);
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
    // Clean up on error
    if (tempCookiesFile) {
      try {
        await fs.unlink(tempCookiesFile);
      } catch (cleanupError) {
        console.warn('Failed to cleanup temporary cookies file:', cleanupError);
      }
    }
    console.error('Error getting video info:', error);
    res.status(500).json({ error: 'Failed to get video info', details: error.message });
  }
});

// Download video endpoint
app.post('/download', async (req, res) => {
  let tempCookiesFile = null;

  try {
    const { url, format, filename, cookies, cookiesContent, browser } = req.body;

    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }

    const outputFilename = filename || `%(title)s.%(ext)s`;
    const outputPath = path.join(DOWNLOADS_DIR, outputFilename);
    const browserName = browser || 'chromium';  // Default to chromium

    // Helper function to clean up temp cookies file
    const cleanup = async () => {
      if (tempCookiesFile) {
        try {
          await fs.unlink(tempCookiesFile);
          tempCookiesFile = null;
        } catch (cleanupError) {
          console.warn('Failed to cleanup temporary cookies file:', cleanupError);
        }
      }
    };

    // Build command with optional cookies
    // Default format: best video up to 720p + best audio, merged
    // Format selector explanation:
    //   bestvideo[height<=720]  - best quality video with max 720p height
    //   bestaudio               - best quality audio
    //   /                       - OR (fallback if above fails)
    //   best[height<=720]       - best pre-merged format with max 720p
    const formatSelector = format || 'bestvideo[height<=720]+bestaudio/best[height<=720]';

    // ALWAYS try browser cookies first, then fall back to explicit cookies, then android client
    console.log(`Step 1: Trying browser cookies (${browserName})...`);

    try {
      const command = `yt-dlp -f "${formatSelector}" -o "${outputPath}" --cookies-from-browser ${browserName} "${url}"`;
      console.log(`Command: ${command}`);
      await execAsync(command);
      console.log(`✓ Browser cookies succeeded!`);
    } catch (browserError) {
      console.log(`✗ Browser cookies failed: ${browserError.message}`);

      // Try explicit cookies if provided
      if (cookiesContent || cookies) {
        console.log(`Step 2: Trying explicit cookies...`);

        try {
          let command;
          let cookiesFile = cookies;

          if (cookiesContent) {
            tempCookiesFile = path.join(DOWNLOADS_DIR, `temp_cookies_${Date.now()}.txt`);
            await fs.writeFile(tempCookiesFile, cookiesContent);
            cookiesFile = tempCookiesFile;
          }

          command = `yt-dlp -f "${formatSelector}" -o "${outputPath}" --cookies "${cookiesFile}" "${url}"`;
          console.log(`Command: ${command}`);
          await execAsync(command);
          console.log(`✓ Explicit cookies succeeded!`);
        } catch (cookiesError) {
          console.log(`✗ Explicit cookies failed: ${cookiesError.message}`);
          await cleanup();

          // Fall back to android client
          console.log(`Step 3: Falling back to android client...`);
          const command = `yt-dlp -f "${formatSelector}" --extractor-args "youtube:player_client=android" -o "${outputPath}" "${url}"`;
          console.log(`Command: ${command}`);
          await execAsync(command);
          console.log(`✓ Android client succeeded!`);
        }
      } else {
        // No explicit cookies, go straight to android client
        console.log(`Step 2: Falling back to android client...`);
        const command = `yt-dlp -f "${formatSelector}" --extractor-args "youtube:player_client=android" -o "${outputPath}" "${url}"`;
        console.log(`Command: ${command}`);
        await execAsync(command);
        console.log(`✓ Android client succeeded!`);
      }
    }

    // Get the actual filename (yt-dlp substitutes template variables)
    // Use browser cookies for info command too
    let info;
    let infoCommand = `yt-dlp --dump-json --cookies-from-browser ${browserName} "${url}"`;
    console.log(`Getting file info with browser cookies...`);

    try {
      const { stdout } = await execAsync(infoCommand);
      info = JSON.parse(stdout);
    } catch (infoError) {
      // Fall back to android client for info
      console.log(`Info with browser cookies failed, using android client...`);
      infoCommand = `yt-dlp --dump-json --extractor-args "youtube:player_client=android" "${url}"`;
      const { stdout } = await execAsync(infoCommand);
      info = JSON.parse(stdout);
    }

    // Clean up temporary cookies file if created
    await cleanup();

    // Try to find the downloaded file
    try {
      const files = await fs.readdir(DOWNLOADS_DIR);

      // If a specific filename was requested, try that first
      if (filename && filename !== '%(title)s.%(ext)s') {
        const requestedFile = filename;
        const requestedPath = path.join(DOWNLOADS_DIR, requestedFile);
        try {
          await fs.access(requestedPath);
          return res.json({
            success: true,
            message: 'Download completed',
            filename: requestedFile,
            path: requestedPath
          });
        } catch (e) {
          console.log(`Requested filename not found, searching for downloaded file...`);
        }
      }

      // Search for files by video ID or title
      const downloadedFiles = files.filter(f =>
        f.includes(info.id) ||
        f.includes(info.title?.substring(0, 20).replace(/[^\w\s-]/g, '')) ||
        (filename && f === filename)
      );

      if (downloadedFiles.length > 0) {
        const actualFilename = downloadedFiles[0];
        const filePath = path.join(DOWNLOADS_DIR, actualFilename);
        return res.json({
          success: true,
          message: 'Download completed',
          filename: actualFilename,
          path: filePath
        });
      }

      // As a last resort, return the most recently modified file
      const fileStats = [];
      for (const file of files) {
        const filePath = path.join(DOWNLOADS_DIR, file);
        const stats = await fs.stat(filePath);
        fileStats.push({ file, mtime: stats.mtime });
      }
      fileStats.sort((a, b) => b.mtime - a.mtime);

      if (fileStats.length > 0) {
        const latestFile = fileStats[0].file;
        const latestPath = path.join(DOWNLOADS_DIR, latestFile);
        return res.json({
          success: true,
          message: 'Download completed',
          filename: latestFile,
          path: latestPath
        });
      }

      throw new Error('Downloaded file not found');
    } catch (error) {
      console.error('Error locating downloaded file:', error);
      res.status(500).json({
        success: false,
        error: 'Download completed but file not found',
        details: error.message
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
  console.error('Error:', err);
  res.status(500).json({ error: 'Something went wrong!', details: err.message });
});

// 404 handler - must be last
app.use('*', (req, res) => {
  console.log(`404 - Method: ${req.method}, Path: ${req.path}, URL: req.url}`);
  res.status(404).json({
    error: 'Endpoint not found',
    method: req.method,
    path: req.path,
    url: req.url,
    availableEndpoints: ['/health', '/', '/info', '/download', '/downloads']
  });
});

app.listen(PORT, () => {
  console.log(`yt-dlp worker running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`Downloads directory: ${DOWNLOADS_DIR}`);
});