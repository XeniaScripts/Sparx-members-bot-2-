// This Vercel function handles the final stage of the Discord OAuth flow.
// It exchanges the temporary code for tokens, fetches user data, and 
// saves the result directly to Google Firestore.

const { URLSearchParams } = require('url');
const { initializeApp, applicationDefault, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

// --- Configuration loaded from Vercel Environment Variables ---
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI; 

// CRITICAL: Firebase Admin configuration for Vercel
const FIREBASE_SERVICE_ACCOUNT = process.env.FIREBASE_SERVICE_ACCOUNT;
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID;

const DISCORD_API_BASE = 'https://discord.com/api/v10';
const USERS_COLLECTION = 'oauth_users'; // Must match Python code

let db; // Firestore instance

// Initialize Firebase Admin SDK
function initializeFirebase() {
    if (db) return db; 

    try {
        // Parse the JSON string from the environment variable
        const serviceAccount = JSON.parse(FIREBASE_SERVICE_ACCOUNT);

        if (!initializeApp.length) { 
            initializeApp({
                credential: cert(serviceAccount),
                projectId: FIREBASE_PROJECT_ID,
            });
        }
        db = getFirestore();
        console.log("Firebase Admin SDK initialized successfully.");
        return db;
    } catch (e) {
        console.error("Firebase Initialization Error:", e.message);
        throw new Error("Failed to initialize Firebase Admin SDK. Check FIREBASE_SERVICE_ACCOUNT variable.");
    }
}


// Simple HTML template for the final page displayed to the user
const htmlTemplate = (status, title, message) => `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title}</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap');
        body { font-family: 'Inter', sans-serif; background-color: #f7f9fb; }
    </style>
</head>
<body class="flex items-center justify-center min-h-screen p-4">
    <div class="max-w-md w-full p-8 bg-white rounded-xl shadow-2xl">
        <div class="text-center">
            ${status === 'success' 
                ? '<svg class="mx-auto h-12 w-12 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>'
                : '<svg class="mx-auto h-12 w-12 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>'
            }
            <h1 class="mt-4 text-2xl font-bold text-gray-900">${title}</h1>
            <p class="mt-2 text-gray-600">${message}</p>
        </div>
        <div class="mt-6">
            <a href="https://discord.com/" class="w-full flex justify-center py-2 px-4 border border-transparent rounded-lg shadow-sm text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500">
                Return to Discord
            </a>
        </div>
    </div>
</body>
</html>
`;

// Main handler for the Vercel function
module.exports = async (req, res) => {
    let tokenResponse, userResponse;
    const { code } = req.query;

    try {
        initializeFirebase();
    } catch (e) {
        return res.status(500).send(htmlTemplate(
            'error', 
            'Server Error', 
            e.message
        ));
    }


    if (!CLIENT_ID || !CLIENT_SECRET || !REDIRECT_URI || !FIREBASE_SERVICE_ACCOUNT) {
        return res.status(500).send(htmlTemplate(
            'error', 
            'Configuration Error', 
            'The required environment variables are not set in Vercel. Contact the bot administrator.'
        ));
    }

    if (!code) {
        return res.status(400).send(htmlTemplate(
            'error', 
            'Access Denied', 
            'No authorization code was provided by Discord. You must click "Authorize".'
        ));
    }

    // --- Phase 1: Exchange Code for Tokens ---
    try {
        const params = new URLSearchParams({
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            grant_type: 'authorization_code',
            code: code,
            redirect_uri: REDIRECT_URI,
            scope: 'identify guilds.join' 
        });

        tokenResponse = await fetch(`${DISCORD_API_BASE}/oauth2/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: params
        });

        if (!tokenResponse.ok) {
            const errorText = await tokenResponse.text();
            throw new Error(`Token Exchange Failed (${tokenResponse.status}): ${errorText}`);
        }

        tokenResponse = await tokenResponse.json();

    } catch (e) {
        console.error('Token Exchange Error:', e.message);
        return res.status(500).send(htmlTemplate(
            'error', 
            'OAuth Error', 
            'Failed to exchange authorization code for tokens. Check CLIENT_ID/SECRET and REDIRECT_URI configuration.'
        ));
    }

    // --- Phase 2: Fetch User Identity ---
    try {
        userResponse = await fetch(`${DISCORD_API_BASE}/users/@me`, {
            headers: { Authorization: `Bearer ${tokenResponse.access_token}` }
        });

        if (!userResponse.ok) {
            const errorText = await userResponse.text();
            throw new Error(`User Fetch Failed (${userResponse.status}): ${errorText}`);
        }

        userResponse = await userResponse.json();

    } catch (e) {
        console.error('User Fetch Error:', e.message);
        return res.status(500).send(htmlTemplate(
            'error', 
            'User Data Error', 
            'Failed to retrieve your Discord profile. Check the OAuth scopes.'
        ));
    }

    // --- Phase 3: Save Data to Firestore (The no-IP step!) ---
    const userData = {
        username: `${userResponse.username}#${userResponse.discriminator || '0'}`,
        access_token: tokenResponse.access_token,
        refresh_token: tokenResponse.refresh_token,
        expires_at: Math.floor(Date.now() / 1000) + tokenResponse.expires_in - 60, // Unix timestamp for Python bot
        scopes: tokenResponse.scope,
        authorized_on: new Date().toISOString()
    };
    
    try {
        // Use user ID as the document ID
        await db.collection(USERS_COLLECTION).doc(userResponse.id).set(userData, { merge: true });

        // Final success page
        return res.status(200).send(htmlTemplate(
            'success', 
            '✅ Access Granted!', 
            `Welcome, ${userResponse.username}! Your authorization is securely saved in Firestore. The bot can now add you using the /join command.`
        ));

    } catch (e) {
        console.error('Firestore Save Error:', e.message);
        return res.status(500).send(htmlTemplate(
            'error', 
            'Database Save Error', 
            `Failed to save data to Firestore. Reason: ${e.message}. Check your Firebase environment variables.`
        ));
    }
};
