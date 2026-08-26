# Changelog

## 0.2.0

- Moved the default Base URL from the Render host to the project's own permanent host at <https://docmint.app.mintapis.com>.
- Existing saved n8n credentials keep whatever Base URL they already have. Upgrading does not rewrite saved credentials, so anyone who saved `https://docmint-832s.onrender.com` must edit the credential by hand.

## 0.1.0

- Initial release of the DocMint community node for n8n.
