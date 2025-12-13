# PM2 Setup for Auto-start on Raspberry Pi

## 1. Installing Dependencies

```bash
yarn install
```

## 2. First Launch via PM2

```bash
yarn pm2:start
```

Check status:

```bash
yarn pm2:status
```

View logs:

```bash
yarn pm2:logs
```

## 3. Setting up Auto-start on Reboot

Run the command to generate startup script:

```bash
pm2 startup
```

PM2 will show a command like:

```bash
sudo env PATH=$PATH:/usr/bin /home/xxx87/.yarn/bin/pm2 startup systemd -u xxx87 --hp /home/xxx87
```

**Copy and run this command** (it will be unique for your system).

## 4. Saving Current PM2 Configuration

After setting up startup, save the current process list:

```bash
pm2 save
```

Now on every Raspberry Pi reboot, the server will start automatically.

## Useful Commands

- `yarn pm2:start` - start the server
- `yarn pm2:stop` - stop the server
- `yarn pm2:restart` - restart the server
- `yarn pm2:delete` - remove from PM2
- `yarn pm2:logs` - show logs
- `yarn pm2:status` - show status

Or directly via PM2:

- `pm2 list` - list all processes
- `pm2 monit` - real-time monitoring
- `pm2 logs` - all logs
- `pm2 flush` - clear logs
