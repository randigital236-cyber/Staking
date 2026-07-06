// sw.js - Service Worker for background sync
const CACHE_NAME = 'rnd-staking-v1';
const SYNC_TAG = 'daily-release-sync';

// Install event
self.addEventListener('install', (event) => {
    console.log('✅ Service Worker installed');
    self.skipWaiting();
});

// Activate event
self.addEventListener('activate', (event) => {
    console.log('✅ Service Worker activated');
    event.waitUntil(clients.claim());
});

// Background sync - Daily release
self.addEventListener('sync', (event) => {
    if (event.tag === SYNC_TAG) {
        console.log('🔄 Background sync triggered for daily release');
        event.waitUntil(processDailyReleaseInBackground());
    }
});

// Process daily release in background
async function processDailyReleaseInBackground() {
    try {
        console.log('🔄 Processing daily release in background...');
        
        // Get current user from IndexedDB or cache
        const userData = await getCachedUserData();
        if (!userData) {
            console.log('No user data found in cache');
            return;
        }
        
        const userId = userData.uid;
        const today = new Date().toDateString();
        
        // Check if already released today
        const lastRelease = userData.lastReleaseDate || '';
        if (lastRelease === today) {
            console.log('✅ Already released today');
            return;
        }
        
        // Process release
        const result = await fetch('/api/process-release', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId, today })
        });
        
        if (result.ok) {
            console.log('✅ Daily release processed in background');
            // Update cache
            await updateCachedUserData(userId);
        }
        
    } catch (error) {
        console.error('❌ Background sync failed:', error);
        // Schedule retry after 1 hour
        setTimeout(() => {
            self.registration.sync.register(SYNC_TAG);
        }, 3600000);
    }
}

// Helper functions
async function getCachedUserData() {
    try {
        const cache = await caches.open(CACHE_NAME);
        const response = await cache.match('/user-data');
        if (response) {
            return await response.json();
        }
        return null;
    } catch (error) {
        console.error('Error getting cached user data:', error);
        return null;
    }
}

async function updateCachedUserData(userId) {
    try {
        // Fetch fresh data and update cache
        const response = await fetch(`/api/user/${userId}`);
        if (response.ok) {
            const data = await response.json();
            const cache = await caches.open(CACHE_NAME);
            const cacheResponse = new Response(JSON.stringify(data), {
                headers: { 'Content-Type': 'application/json' }
            });
            await cache.put('/user-data', cacheResponse);
        }
    } catch (error) {
        console.error('Error updating cache:', error);
    }
}

// Listen for messages from main page
self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'SYNC_NOW') {
        self.registration.sync.register(SYNC_TAG);
    }
});
