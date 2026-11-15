#!/bin/bash
cd ~/projects/flame-firewall-nasa-space-apps/worker/fireline-verdict

while true; do
	echo "running deploy"
	npx wrangler deploy
	echo "deployed; pausing for 300s"
	sleep 300;
done
