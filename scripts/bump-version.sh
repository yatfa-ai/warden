#!/usr/bin/env bash
# Bump the patch version in package.json, commit, tag vX.Y.Z, and push to main.
#
# Mirrors yatfa's script/bump-version.sh, adapted for a Node/Electron project:
#   - version source is package.json (electron-builder reads it), not a VERSION file
#   - release is tag-based (GitHub Release attaches to vX.Y.Z); warden has no
#     `prod` deploy-mirror branch, so the prod-branch push from yatfa is dropped
#
# Strategy carried over verbatim: must be on main with a clean tree, patch-only
# bump, commit "bump: X -> Y", pull --rebase + push with up to 3 retries.
#
# When run inside GitHub Actions (GITHUB_OUTPUT set), exports `version` and
# `tag` to the step's job outputs. Locally it just prints the new version.
set -e

# Ensure we're on the main branch
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$CURRENT_BRANCH" != "main" ]; then
    echo "Error: Not on main branch. Current branch: $CURRENT_BRANCH"
    exit 1
fi

# Check if working directory is clean
if [ -n "$(git status --porcelain)" ]; then
    echo "Error: Working directory has uncommitted changes"
    exit 1
fi

# Read current version from package.json (Node is always available for this project)
CURRENT_VERSION=$(node -p "require('./package.json').version")
echo "Current version: $CURRENT_VERSION"

# Bump patch version (0.1.1 -> 0.1.2)
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT_VERSION"
NEW_PATCH=$((PATCH + 1))
NEW_VERSION="$MAJOR.$MINOR.$NEW_PATCH"
echo "New version: $NEW_VERSION"

# Write the new version back to package.json. Surgical regex replace on the
# "version" line only — re-serializing would reformat the rest of the file
# (e.g. expand inline arrays) and bloat the bump commit.
NEW_VERSION="$NEW_VERSION" node -e "
  const fs = require('fs');
  const p = './package.json';
  const s = fs.readFileSync(p, 'utf8');
  const re = /(\"version\"\s*:\s*\")[0-9]+\.[0-9]+\.[0-9]+(\")/;
  if (!re.test(s)) { console.error('Error: could not find \"version\" field in package.json'); process.exit(1); }
  fs.writeFileSync(p, s.replace(re, \`\$1\${process.env.NEW_VERSION}\$2\`));
  console.log('package.json version -> ' + process.env.NEW_VERSION);
"

# Create commit
git add package.json
git commit -m "bump: $CURRENT_VERSION -> $NEW_VERSION"

# Tag the release (the GitHub Release attaches its assets to this tag)
git tag "v$NEW_VERSION"

# Pull with rebase to incorporate any commits that landed on main since checkout,
# then push the branch and the tag. Retry up to 3 times to handle concurrent pushes.
MAX_RETRIES=3
RETRY_COUNT=0
PUSH_SUCCESS=false

while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
    if git pull --rebase origin main; then
        if git push origin main && git push origin "v$NEW_VERSION"; then
            PUSH_SUCCESS=true
            break
        fi
    fi
    RETRY_COUNT=$((RETRY_COUNT + 1))
    if [ $RETRY_COUNT -lt $MAX_RETRIES ]; then
        echo "Push failed, retrying ($RETRY_COUNT/$MAX_RETRIES)..."
        sleep 5
    fi
done

if [ "$PUSH_SUCCESS" = false ]; then
    echo "Error: Failed to push version bump after $MAX_RETRIES attempts"
    exit 1
fi

echo "Version bumped to $NEW_VERSION and pushed to main with tag v$NEW_VERSION"

# Export to GitHub Actions job outputs when run in CI
if [ -n "$GITHUB_OUTPUT" ]; then
    echo "version=$NEW_VERSION" >> "$GITHUB_OUTPUT"
    echo "tag=v$NEW_VERSION" >> "$GITHUB_OUTPUT"
fi
