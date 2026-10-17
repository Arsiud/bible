// Firebase web settings for the Connection tab. These aren't secret; they ship with the site.
// Database rules live in ../firebase (deploy from there with `firebase deploy --only firestore:rules`).
export const firebaseConfig = {
  apiKey: "AIzaSyAYDG3UVj2Ce_uIeQ-WbSErbZFKWsEIMog",
  authDomain: "bible-connect-idqoo.firebaseapp.com",
  projectId: "bible-connect-idqoo",
  storageBucket: "bible-connect-idqoo.firebasestorage.app",
  messagingSenderId: "379507533954",
  appId: "1:379507533954:web:0a797322ed87d377a62c9b",
};

// The owner's account ID (approves people, sets the shared ESV key). Must match OWNER_UID
// in ../firebase/firestore.rules. Filled in after the owner's first sign-in.
export const ownerUid = null;
