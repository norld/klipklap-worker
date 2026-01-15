#!/bin/bash

# Test yt-dlp worker download endpoint
curl -X POST 'http://localhost:3002/download' \
  -H 'Content-Type: application/json' \
  -H 'X-API-Key: yt-dlp-ssupperrrsecret' \
  -d '{"url":"https://youtu.be/dQw4w9WgXcQ","format":"bestaudio","filename":"test.mp3"}'
