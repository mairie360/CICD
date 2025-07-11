#!/usr/bin/env bash
set -e

VERSION=$1
if [ -z "$VERSION" ]; then
    echo "Usage: ./publish.sh <version>"
    exit 1
fi

echo "🚀 Publishing $VERSION to private cargo registry"

# Vérifie que MAIRIE_360_DEPLOY_TOKEN est défini
if [ -z "$MAIRIE_360_DEPLOY_TOKEN" ]; then
    echo "Error: MAIRIE_360_DEPLOY_TOKEN environment variable is not set"
    exit 1
fi

# Clone l'index via HTTPS avec token
git clone https://$MAIRIE_360_DEPLOY_TOKEN@github.com/mairie360/cargo-index.git /tmp/index
cd /tmp/index

CRATE_NAME=$(cargo metadata --no-deps --format-version=1 | jq -r '.packages[0].name')
cd -

cargo package

CRATE_FILE="target/package/${CRATE_NAME}-${VERSION}.crate"
CHECKSUM=$(sha256sum "$CRATE_FILE" | cut -d ' ' -f1)

DEPS_JSON=$(cargo metadata --format-version=1 --no-deps | jq --arg CRATE "$CRATE_NAME" '.packages[] | select(.name == $CRATE) | .dependencies | map({
  name: .name,
  req: .req,
  features: [],
  optional: false,
  default_features: true,
  target: null,
  kind: "normal",
  registry: null,
  package: null
})')

FIRST_CHAR=$(echo -n "$CRATE_NAME" | head -c 1)
CRATE_INDEX_FILE="/tmp/index/$FIRST_CHAR/$CRATE_NAME"

mkdir -p "$(dirname "$CRATE_INDEX_FILE")"
echo "{\"name\":\"$CRATE_NAME\",\"vers\":\"$VERSION\",\"deps\":$DEPS_JSON,\"cksum\":\"$CHECKSUM\",\"features\":{},\"yanked\":false,\"links\":null}" >> "$CRATE_INDEX_FILE"

cd /tmp/index
git add "$CRATE_INDEX_FILE"
git commit -m "Add $CRATE_NAME $VERSION"
git push

# echo "📤 Uploading crate"
# scp "$CRATE_FILE" user@mairie360-eip.fr:/var/www/html/crates/$CRATE_NAME/$VERSION/download
