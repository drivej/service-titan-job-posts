# Create Symbolic Link (Mac)

ln -s /Users/{username}/lab/service-titan-job-post /Users/{username}/Local\ Sites/service-titan-job-post/app/public/wp-content/plugins/service-titan-job-post


# Sevalla env Vars

WP_URL = Your WordPress REST API URL.
WP_USER = Your WP Username.
WP_APP_PASS = A WordPress Application Password.

    How to Generate One for Your ScriptLog in to your WordPress dashboard.
    Navigate to Users → Profile (or your specific user account).
    Scroll down to the Application Passwords section.
    Enter a descriptive name like Sevalla Job Sync.
    Click Add New Application Password.
    Copy the 24-character code immediately; it will never be shown again.

ST_APP_KEY = Your App Key from the ServiceTitan Dev Portal.

    You obtain the App Key directly from the ServiceTitan Developer Portal.
    Log In: Go to the ServiceTitan Developer Portal and log in to "My Apps" using your production or integration environment credentials.
    Create an App: If you haven't already, click +New App, fill in the details, and select your required API scopes.
    Copy the Key: Once the app is created, navigate to the Keys or Application Key section within the app details to find and copy your key.

# Gotchas

    Go to Settings → Permalinks.Ensure you are not using the "Plain" structure (API routes require "Post name" or similar).
