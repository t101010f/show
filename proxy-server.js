const express = require('express');
const cors = require('cors');
const axios = require('axios');
const app = express();

// تمكين CORS لجميع الطلبات
app.use(cors({
    origin: '*',
    methods: ['GET', 'HEAD', 'OPTIONS'],
    allowedHeaders: '*',
    exposedHeaders: '*',
    credentials: true
}));

// إضافة نقطة نهاية الصحة
app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

// تخزين مؤقت للأجزاء والتسلسل
const segmentCache = new Map();
const CACHE_DURATION = 30000; // 30 seconds
const playlistCache = new Map();
const PLAYLIST_CACHE_DURATION = 2000; // 2 seconds

// Track media sequences
let lastMediaSequence = null;
let lastHost = null;

// معالج الطلبات الرئيسي
app.get('/proxy', async (req, res) => {
    const url = req.query.url;
    if (!url) {
        return res.status(400).send('URL parameter is required');
    }

    try {
        console.log('Proxying request to:', url);
        
        // التحقق من نوع الطلب (m3u8 أو segment)
        const isM3u8 = url.includes('index.m3u8');
        const isSegment = url.includes('.js?') || url.includes('.ts');
        
        // التحقق من وجود الجزء في التخزين المؤقت
        const cache = isM3u8 ? playlistCache : segmentCache;
        const cacheDuration = isM3u8 ? PLAYLIST_CACHE_DURATION : CACHE_DURATION;
        
        if (cache.has(url)) {
            const cachedData = cache.get(url);
            if (Date.now() - cachedData.timestamp < cacheDuration) {
                console.log('Serving from cache:', url);
                res.set(cachedData.headers);
                return res.send(cachedData.data);
            } else {
                cache.delete(url);
            }
        }

        const response = await axios({
            method: 'get',
            url: url,
            responseType: isM3u8 ? 'text' : 'arraybuffer',
            timeout: 30000,
            maxRedirects: 5,
            validateStatus: null,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                'Accept': '*/*',
                'Accept-Language': 'en-US,en;q=0.9',
                'Origin': 'http://localhost:8080',
                'Referer': 'http://localhost:8080/',
                'Connection': 'keep-alive',
                'Range': req.headers.range || 'bytes=0-'
            }
        });

        // معالجة إعادة التوجيه يدوياً
        if (response.status === 301 || response.status === 302) {
            const redirectUrl = response.headers.location;
            if (redirectUrl) {
                console.log('Following redirect to:', redirectUrl);
                const redirectResponse = await axios({
                    method: 'get',
                    url: redirectUrl,
                    responseType: isM3u8 ? 'text' : 'arraybuffer',
                    timeout: 30000,
                    maxRedirects: 5,
                    validateStatus: null,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                        'Accept': '*/*',
                        'Accept-Language': 'en-US,en;q=0.9',
                        'Origin': 'http://localhost:8080',
                        'Referer': 'http://localhost:8080/',
                        'Connection': 'keep-alive',
                        'Range': req.headers.range || 'bytes=0-'
                    }
                });
                
                if (redirectResponse.status === 200 || redirectResponse.status === 206) {
                    const headers = {
                        'Content-Type': redirectResponse.headers['content-type'],
                        'Content-Length': redirectResponse.headers['content-length'],
                        'Access-Control-Allow-Origin': '*',
                        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
                        'Access-Control-Allow-Headers': '*',
                        'Access-Control-Expose-Headers': '*',
                        'Access-Control-Allow-Credentials': 'true',
                        'Cache-Control': 'no-cache',
                        'Connection': 'keep-alive'
                    };

                    if (redirectResponse.headers['content-range']) {
                        headers['Content-Range'] = redirectResponse.headers['content-range'];
                    }

                    let responseData = redirectResponse.data;
                    
                    // معالجة خاصة لملفات M3U8
                    if (isM3u8 && typeof responseData === 'string') {
                        responseData = handleM3u8Response(responseData, url);
                    }

                    cache.set(url, {
                        data: responseData,
                        headers: headers,
                        timestamp: Date.now()
                    });

                    res.set(headers);
                    res.status(redirectResponse.status).send(responseData);
                    console.log('Successfully proxied redirect:', redirectUrl);
                    return;
                }
            }
        }

        // معالجة الاستجابة الأصلية
        if (response.status === 200 || response.status === 206) {
            const headers = {
                'Content-Type': response.headers['content-type'],
                'Content-Length': response.headers['content-length'],
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
                'Access-Control-Allow-Headers': '*',
                'Access-Control-Expose-Headers': '*',
                'Access-Control-Allow-Credentials': 'true',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive'
            };

            if (response.headers['content-range']) {
                headers['Content-Range'] = response.headers['content-range'];
            }

            let responseData = response.data;
            
            // معالجة خاصة لملفات M3U8
            if (isM3u8 && typeof responseData === 'string') {
                responseData = handleM3u8Response(responseData, url);
            }

            cache.set(url, {
                data: responseData,
                headers: headers,
                timestamp: Date.now()
            });

            res.set(headers);
            res.status(response.status).send(responseData);
            console.log('Successfully proxied:', url);
        } else {
            console.error('Proxy Error - Status:', response.status);
            res.status(response.status).send(response.data);
        }
    } catch (error) {
        console.error('Proxy Error:', error.message);
        res.status(500).send(error.message);
    }
});

// معالجة ملفات M3U8
function handleM3u8Response(content, url) {
    // Extract current host from URL
    const currentHost = url.match(/https?:\/\/([^\/]+)/)?.[1];
    
    // Extract media sequence
    const mediaSeqMatch = content.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/);
    const currentMediaSeq = mediaSeqMatch ? parseInt(mediaSeqMatch[1]) : null;
    
    // If this is a new host or the media sequence is out of sync
    if (currentHost && currentMediaSeq !== null) {
        if (lastHost && lastHost !== currentHost && lastMediaSequence !== null) {
            // Adjust media sequence to maintain continuity
            const newContent = content.replace(
                /#EXT-X-MEDIA-SEQUENCE:\d+/,
                `#EXT-X-MEDIA-SEQUENCE:${lastMediaSequence}`
            );
            content = newContent;
        } else {
            lastHost = currentHost;
            lastMediaSequence = currentMediaSeq;
        }
    }

    // Update segment URLs to use proxy
    content = content.replace(/(https?:\/\/[^\/]+\/[^\n]+)/g, (match) => {
        if (match.includes('.m3u8') || match.includes('.ts') || match.includes('.js?')) {
            return `http://localhost:3001/proxy?url=${encodeURIComponent(match)}`;
        }
        return match;
    });
    
    return content;
}

// معالج خاص لطلبات OPTIONS
app.options('/proxy', cors({
    origin: '*',
    methods: ['GET', 'HEAD', 'OPTIONS'],
    allowedHeaders: '*',
    exposedHeaders: '*',
    credentials: true
}));

// تنظيف التخزين المؤقت كل دقيقة
setInterval(() => {
    const now = Date.now();
    for (const [url, data] of segmentCache.entries()) {
        if (now - data.timestamp > CACHE_DURATION) {
            segmentCache.delete(url);
        }
    }
    for (const [url, data] of playlistCache.entries()) {
        if (now - data.timestamp > PLAYLIST_CACHE_DURATION) {
            playlistCache.delete(url);
        }
    }
}, 60000);

// تشغيل الخادم على منفذ 3001
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`Proxy server running on port ${PORT}`);
}); 