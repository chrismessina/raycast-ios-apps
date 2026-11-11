# iOS Apps Changelog

## [Initial Version] - {PR_MERGE_DATE}

- Search the App Store by name, developer, bundle ID, App Store URL, or numeric app ID — pasting a URL or ID finds apps too new for Apple's term index
- Pass a query straight to Search from the root search with its optional Query argument
- Filter search results by platform (iPhone, iPad, Mac, Apple TV), remembered between launches
- View Purchased Apps: everything the signed-in Apple ID owns, paged as you scroll, sortable by purchase date or name
- Browse every app by one developer without leaving Raycast
- Download IPAs through `ipatool`, renamed to `{App Name} {Version}.ipa`, with integrity verification
- Downloads run in the background and keep going if you close Raycast; a finished one is saved the next time you open a download command
- Cancel a download from its progress toast
- Download full-resolution screenshots and app icons, organised per platform
- Favorites with Markdown and CSV export, plus download history and recent searches
- Five Raycast AI tools: search, details, current version, download, and screenshot download
- Run Doctor: checks ipatool and your Apple ID, updates a Homebrew ipatool in place, and takes the verification code Apple sends when it expires a session
- Works with `ipatool` 2.8.0; after upgrading from an older version, sign in again once (Run Doctor)
- Requires `ipatool` 2.6.0 or greater
