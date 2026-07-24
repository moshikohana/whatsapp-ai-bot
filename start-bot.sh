#!/bin/bash
# Launch the WhatsApp bot inside a real D-Bus session. Chrome 146+ aborts
# fatally ("D-Bus connection was disconnected. Aborting.") when the
# inherited DBUS_SESSION_BUS_ADDRESS points at a nonexistent socket
# (/run/user/0/bus — not created for pm2's non-login systemd context).
# dbus-run-session spins up a private session bus for the process tree.
#
# On the Hetzner server pm2 runs the bot via THIS wrapper, not index.js
# directly:  pm2 start /opt/whatsapp-ai-bot/start-bot.sh --name whatsapp-bot
cd /opt/whatsapp-ai-bot || exit 1
unset DBUS_SESSION_BUS_ADDRESS
exec dbus-run-session -- node index.js
