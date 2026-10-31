#!/bin/sh
# Install or update the recorder on a server as a systemd user service.
#   recorder/install-remote.sh user@host [ssh-key]
# The server user needs lingering (once, as admin): sudo loginctl enable-linger <user>
set -e
target=${1:?usage: install-remote.sh user@host [ssh-key]}
key=${2:-$HOME/.ssh/sofia_recorder_ed25519}
here=$(cd "$(dirname "$0")" && pwd)
opts="-i $key -o IdentitiesOnly=yes -o BatchMode=yes"
ssh $opts "$target" 'mkdir -p ~/sofia-recorder/recordings ~/.config/systemd/user'
scp -q $opts "$here/record.py" "$here/status.py" "$target:sofia-recorder/"
sed 's#%h/.local/share/sofia-recorder/record.py --dir %h/Documents/sofiametro/recordings#%h/sofia-recorder/record.py --dir %h/sofia-recorder/recordings#' \
  "$here/sofia-recorder.service" | ssh $opts "$target" 'cat > ~/.config/systemd/user/sofia-recorder.service'
ssh $opts "$target" 'systemctl --user daemon-reload && systemctl --user enable sofia-recorder && systemctl --user restart sofia-recorder &&
  systemctl --user is-active sofia-recorder && loginctl show-user "$USER" -p Linger'
