# Class Participation Marking — Setup & Deploy Guide

This guide takes you from the app files to a live web link that all your TAs and
students can open on their own phones or laptops, seeing the same live data in
real time.

You do **not** need to write any code. You'll do two things:

1. **Connect a free shared database** (Firebase) — so everyone's devices share
   the same data. About 10–15 minutes, one time.
2. **Put the app online** (Netlify) — drag a folder, get a link. About 3 minutes.

Total: ~20 minutes. It's all free at your class's size.

> **Why this is needed:** the app you built stores data inside each person's
> browser by itself. That's fine on one computer, but it means a TA's marks
> would never reach the students' phones. Adding the shared database is what
> makes it work "everyone, live." All the code for this is already done — you
> just have to create the free account and paste in six values.

---

## What's in this folder

| File | What it is | Do you edit it? |
|---|---|---|
| `index.html` | The app itself | No |
| `support.js` | App engine | No |
| `store.js` | The data logic (already wired to the shared database) | Only to change passwords (see *Managing the app*) |
| **`firebase-config.js`** | **Where you paste your database keys** | **Yes — Part 3** |
| `config/students.json` | Your student list | To update the roster (Part 7) |
| `config/tas.json` | Your TA list | To update the TAs (Part 7) |
| `SETUP-GUIDE.md` | This guide | No |

---

## Part 1 — Create the free database (Firebase)

1. Go to **https://console.firebase.google.com** and sign in with any Google
   account.
2. Click **Create a project** (or **Add project**).
3. Give it a name, e.g. `cp-marking`, and click **Continue**.
4. On the Google Analytics step, switch it **off** (you don't need it), then
   click **Create project**. Wait a few seconds, then **Continue**.

### 1a. Register the app to get your keys

5. On the project home screen, click the **web icon `</>`** (labelled "Web").
   *(If you don't see it: click the gear ⚙ next to "Project Overview" →
   Project settings → scroll to "Your apps" → click the `</>` web icon.)*
6. Enter a nickname, e.g. `CP app`. **Leave "Firebase Hosting" unchecked.**
   Click **Register app**.
7. You'll now see a block of code containing `const firebaseConfig = { ... }`
   with six values (`apiKey`, `authDomain`, `projectId`, `storageBucket`,
   `messagingSenderId`, `appId`). **Keep this screen open** — you'll copy these
   in Part 3. Then click **Continue to console**.

### 1b. Turn on the database (Firestore)

8. In the left menu, click **Build → Firestore Database**.
9. Click **Create database**.
10. Choose a location closest to you (for Pakistan, `asia-south1` (Mumbai) is a
    good choice). Click **Next**.
11. Choose **Start in production mode**, then **Create**. (We'll add the exact
    access rule in Part 4.)

### 1c. Turn on anonymous sign-in

This lets the app quietly identify each device so only people who open your app
can read/write the data — without anyone having to create a Firebase account.

12. In the left menu, click **Build → Authentication**.
13. Click **Get started**.
14. Open the **Sign-in method** tab.
15. In the providers list, click **Anonymous**, switch it **Enable**, and click
    **Save**.

---

## Part 2 — (nothing to install)

There's nothing to install on your computer. Keep going.

---

## Part 3 — Paste your keys into the app

1. Open the file **`firebase-config.js`** (in this folder) with any plain text
   editor (Notepad on Windows, TextEdit on Mac, or VS Code).
2. Replace each `PASTE_..._HERE` placeholder with the matching value from the
   Firebase screen in step 7. **Keep the quotation marks and commas.**

It should end up looking like this (with *your* values, not these):

```js
export const firebaseConfig = {
  apiKey: "AIzaSyB3xample-KeyHere1234567890",
  authDomain: "cp-marking.firebaseapp.com",
  projectId: "cp-marking",
  storageBucket: "cp-marking.appspot.com",
  messagingSenderId: "123456789012",
  appId: "1:123456789012:web:abc123def456",
};
```

3. **Save** the file.

> If you ever lose the values: Firebase console → gear ⚙ → **Project settings**
> → scroll to **Your apps** → they're shown there again.

---

## Part 4 — Set the security rule

This one rule says: "only someone who has opened my app can read or write the
class data." Copy-paste it exactly.

1. Firebase console → **Build → Firestore Database → Rules** tab.
2. Delete whatever is there and paste this in:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /cp_marking/state {
      allow read, write: if request.auth != null;
    }
  }
}
```

3. Click **Publish**.

---

## Part 5 — Put the app online (Netlify Drop)

1. Make sure all the files in this folder are together in **one folder** (they
   already are). Double-check `firebase-config.js` is saved with your keys.
2. Go to **https://app.netlify.com/drop**
3. **Drag the whole folder** onto the big drop area on that page.
4. Wait for the upload to finish. Netlify gives you a live link like
   `https://gentle-otter-12345.netlify.app`. **That's your app.**
5. To keep the link and give it a nicer name, click **sign up** (free — use
   Google or email) to claim the site. Then go to **Site configuration →
   Change site name** and set something like `topics-cp` → your link becomes
   `https://topics-cp.netlify.app`.

> **Write down your final link** — e.g. `https://topics-cp.netlify.app`. You'll
> need it for the next step and to share with the class.

### Using Vercel instead of Netlify

Vercel works too — drag the folder to **https://vercel.com/new**, or import the
folder as a project. The `vercel.json` file in this folder tells Vercel the app
is a plain static site with nothing to build, so leave the framework preset as
**Other** and don't add a build command. Whichever host you use, the domain must
still be added in **Part 6**.

---

## Part 6 — Authorise your link in Firebase  ⚠ don't skip

Anonymous sign-in only works on web addresses you've approved. Your new Netlify
link must be added, or the app will show *"Could not connect to the shared
backend."*

1. Firebase console → **Build → Authentication → Settings** tab →
   **Authorized domains**.
2. Click **Add domain**.
3. Type just the domain part of your link — e.g. `topics-cp.netlify.app`
   (no `https://`, no trailing slash). Click **Add**.

Now open your Netlify link. The yellow "Setup notice" on the sign-in screen
should be gone. You're live. 🎉

---

## Part 7 — Hand it to your class

Share three things with everyone:

- **The link**, e.g. `https://topics-cp.netlify.app`
- **How to sign in:**
  - On the sign-in screen, pick **Teaching assistant** or **Student**.
  - **Username** is their handle from the roster (e.g. `abdul.ali`,
    `ammara.haroon`). It's the person's name in lowercase with a dot — the app
    also accepts the full name and converts it.
  - **Password:**
    - TAs: `@AHIta2026`
    - Students: `cp2026`

Everyone uses the same password for their role. (You can change these — see
below.)

---

## Managing the app

### Change the passwords (recommended before the first real class)

1. Open **`store.js`** in a text editor.
2. Near the top, find:
   ```js
   const TA_PASSWORD = "@AHIta2026";
   const STUDENT_PASSWORD = "cp2026";
   ```
3. Change the values (keep the quotes), save.
4. Re-deploy: go to your site on Netlify → **Deploys** tab → drag the folder
   onto the page again to publish the update.

### Update the student or TA list

1. Open **`config/students.json`** (or `config/tas.json`).
2. Follow the same pattern for each person. Students look like:
   ```json
   { "id": "s039", "name": "New Student", "username": "new.student", "group": null }
   ```
   Give each person a unique `id` and `username`. `group` can be a number or
   `null`.
3. Save, then re-deploy (drag the folder onto your Netlify site's **Deploys**
   tab again).

### Clear the demo data before your first real class

The app ships with two fake past sessions so it looks alive when you try it.
To wipe them and start clean:

1. Open your live app link in Chrome.
2. Press **F12** to open the developer tools, click the **Console** tab.
3. Paste this and press Enter:
   ```js
   import('./store.js').then(S => S.resetDemo(false))
   ```
   This resets the shared data to a clean slate for everyone.
   *(Use `S.resetDemo(true)` instead if you ever want the demo data back.)*

---

## Good to know

- **Cost:** Firebase's free "Spark" plan and Netlify's free plan are both far
  more than a class of ~40 needs. You won't be asked for a card.
- **Security, honestly:** because everything runs in the browser, the role
  passwords are visible to anyone who really digs into the page. That's normal
  and fine for classroom participation — it keeps casual outsiders out. Don't
  store anything sensitive here.
- **This guide gets published too.** It sits in the same folder you upload, so
  anyone can open `https://your-link/SETUP-GUIDE.md` and read the passwords off
  it. Before you share the link with the class, delete `SETUP-GUIDE.md` from the
  folder you deploy (keep your own copy elsewhere).
- **Across a whole term:** data keeps accumulating in one record. It's tiny, but
  at the end of a term it's good practice to **Export** each session to Excel
  (button in the TA console) and then run the reset command above for the new
  term.
- **Presenter display:** the "Open presenter display" button on the sign-in
  screen gives a projector-friendly view for the front of the room.

---

## Troubleshooting

| You see… | Fix |
|---|---|
| Can't click buttons or type in the login boxes (page looks frozen) | `firebase-config.js` is missing the word **`export`** at the start (Firebase's console gives you `const firebaseConfig = {` — it must be `export const firebaseConfig = {`). Fix that one word, re-deploy. |
| Yellow "Setup notice: Shared backend not connected" | You haven't finished Part 3 (paste keys), the first line is missing `export`, or you didn't re-deploy after editing. Check `firebase-config.js`, then re-deploy. |
| "Could not connect… unauthorized domain" | Do **Part 6** — add your Netlify domain to Firebase Authorized domains. |
| "Could not connect… (permission-denied)" | Re-check the rule in **Part 4** and that **Anonymous** sign-in is enabled (**Part 1c**). |
| One TA's marks don't show for others | Confirm every device is opening the **same** Netlify link, and the "Setup notice" is gone on each. |
| Changes I made to files aren't showing | Re-deploy: drag the folder onto your Netlify site's **Deploys** tab again, then refresh (Ctrl/Cmd+Shift+R). |
| On Vercel: `500 FUNCTION_INVOCATION_FAILED` | The host is treating the app as a Node server instead of a static site. Make sure `vercel.json` is in the folder you upload, that there is **no** `package.json`, and that no file at the top level is named `server.js`, `app.js` or `index.js` (the data file is called `store.js` for exactly this reason). |

If you get stuck on any step, tell me what you see on screen and I'll walk you
through it.
