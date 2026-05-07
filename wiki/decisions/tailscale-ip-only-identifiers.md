# Tailscale IP Only Identifiers

## Decision

When referencing reachable machines for this project, use Tailscale IP addresses only. Do not use local-network identifiers, LAN hostnames, or LAN IPs in operator-facing instructions.

## Current Required Mappings

- appserver: `100.76.136.91`
- jims-mac-mini (mac): `100.76.176.119`
- pixel 9a: `100.72.61.52`

## App Connection Requirement

The phone app must support selecting between multiple Tailscale-backed machines. At minimum, app-to-Mac and app-to-MSI/appserver connections should both be possible and available as selectable saved machine targets.

- Mac target: `100.76.176.119`
- MSI/appserver target: `100.76.136.91`

## Notes

- This applies especially to phone app setup, remote API URLs, QA notes, and troubleshooting instructions.
- If a Tailscale name or Funnel URL is useful for explanation, prefer the Tailscale IP unless the user explicitly asks for the URL.
