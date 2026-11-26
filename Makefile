.PHONY: run test demo stop

run:
	docker compose up --build

test:
	npm test && npm run test:contract && npm run test:e2e && npm run test:mcp

demo:
	npm run build && npm run demo:mcp -- --mode=deterministic --auto-confirm

stop:
	docker compose down
