#!/usr/bin/env bash
# Install the systemd units and the Apache config, rewriting the default paths to wherever you
# actually put things. Run once, as root, after cloning the two repositories.
#
#   ./deploy/install.sh
#   APP=/srv/webcip SRC=/srv/pypv VAR=/srv/webcip-data ./deploy/install.sh
#
# The units in this directory are written for /opt/webcip, /opt/pypv and /var/lib/webcip. Nothing
# depends on those particular paths, but three files have to agree on them — this substitutes all
# three at once so they cannot drift apart.
set -euo pipefail

APP=${APP:-/opt/webcip}          # this repo
SRC=${SRC:-/opt/pypv}            # the pypv checkout (WEBCIP_SRC)
VAR=${VAR:-/var/lib/webcip}      # uploads, data, the service account's home
USER_NAME=${USER_NAME:-ec2-user}
HOME_DIR=${HOME_DIR:-$(getent passwd "$USER_NAME" | cut -d: -f6)}
UNITS=${UNITS:-/etc/systemd/system}

[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }

here=$(cd "$(dirname "$0")" && pwd)

subst() { sed -e "s#/opt/webcip#$APP#g" -e "s#/opt/pypv#$SRC#g" \
              -e "s#/var/lib/webcip#$VAR#g" \
              -e "s#^User=ec2-user#User=$USER_NAME#" -e "s#^Group=ec2-user#Group=$USER_NAME#" \
              -e "s#^Environment=HOME=.*#Environment=HOME=$HOME_DIR#" "$1"; }

for unit in webcip.service webcip-prune.service webcip-prune.timer \
            webcip-restart.service webcip-restart.timer; do
  subst "$here/$unit" > "$UNITS/$unit"
  echo "  installed $UNITS/$unit"
done

# The vhost proxies to a PORT, so it does not care where the app lives on disk — the only path
# in it is the deny rule for a stale copy under DocumentRoot.
if [ -d /etc/httpd/conf.d ]; then                      # RHEL / Amazon Linux: active immediately
  install -m 644 "$here/apache-webcip.conf" /etc/httpd/conf.d/webcip.conf
  echo "  installed /etc/httpd/conf.d/webcip.conf (apachectl configtest && systemctl reload httpd)"
elif [ -d /etc/apache2/conf-available ]; then          # Debian / Ubuntu: needs enabling
  install -m 644 "$here/apache-webcip.conf" /etc/apache2/conf-available/webcip.conf
  echo "  installed /etc/apache2/conf-available/webcip.conf (a2enconf webcip to enable)"
fi

systemctl daemon-reload
echo
echo "paths: app=$APP src=$SRC var=$VAR user=$USER_NAME"
echo "next:  systemctl enable --now webcip webcip-prune.timer webcip-restart.timer"
echo
echo "deploy.sh takes the same two variables, and runs as the service account:"
echo "  sudo -u $USER_NAME WEBCIP_APP=$APP WEBCIP_SRC=$SRC $APP/deploy/deploy.sh"
