/** Configuration PM2 : deux process, web + worker. */
module.exports = {
  apps: [
    {
      name: "ema-web",
      script: "node_modules/next/dist/bin/next",
      args: "start -p 3000",
      cwd: __dirname,
      env: { NODE_ENV: "production" },
      max_memory_restart: "600M",
      time: true,
    },
    {
      name: "ema-worker",
      script: "node_modules/.bin/tsx",
      args: "src/worker/index.ts",
      cwd: __dirname,
      env: { NODE_ENV: "production" },
      max_memory_restart: "400M",
      restart_delay: 5000,
      time: true,
    },
  ],
};
