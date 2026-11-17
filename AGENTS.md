# Deployment preferences

Use Coop's native, supported behavior and configuration. Do not add chart-owned
retention policies, database TTL overrides, or cleanup jobs to emulate features
missing in Coop. If Coop lacks a requested setting, explain the gap and address it
upstream rather than silently implementing a deployment-specific substitute.
