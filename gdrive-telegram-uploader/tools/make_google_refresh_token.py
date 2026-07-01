import os

from google_auth_oauthlib.flow import InstalledAppFlow

SCOPES = ["https://www.googleapis.com/auth/drive.readonly"]


def main():
    client_id = os.getenv("GOOGLE_CLIENT_ID") or input("GOOGLE_CLIENT_ID: ").strip()
    client_secret = os.getenv("GOOGLE_CLIENT_SECRET") or input("GOOGLE_CLIENT_SECRET: ").strip()

    config = {
        "installed": {
            "client_id": client_id,
            "client_secret": client_secret,
            "auth_uri": "https://accounts.google.com/o/oauth2/auth",
            "token_uri": "https://oauth2.googleapis.com/token",
            "redirect_uris": ["http://localhost"],
        }
    }

    flow = InstalledAppFlow.from_client_config(config, SCOPES)
    creds = flow.run_local_server(port=0, prompt="consent")

    print("\nSAVE THIS AS GOOGLE_REFRESH_TOKEN:\n")
    print(creds.refresh_token)
    print("\nDo not send this value in chat and do not commit it to GitHub.\n")


if __name__ == "__main__":
    main()
