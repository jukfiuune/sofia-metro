#!/bin/sh
# Install or update the recorder as a systemd user service.
set -e
here=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$HOME/.local/share/sofia-recorder" "$HOME/.config/systemd/user"
cp "$here/record.py" "$HOME/.local/share/sofia-recorder/record.py"
cp "$here/sofia-recorder.service" "$HOME/.config/systemd/user/sofia-recorder.service"
systemctl --user daemon-reload
systemctl --user enable --now sofia-recorder.service
systemctl --user restart sofia-recorder.service
systemctl --user --no-pager status sofia-recorder.service | head -5
