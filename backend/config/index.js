'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

module.exports = {
  port:    process.env.PORT    || 3000,
  nodeEnv: process.env.NODE_ENV || 'development',
  logLevel: process.env.LOG_LEVEL || 'info',
  serverPublicIp: process.env.SERVER_PUBLIC_IP || '127.0.0.1',

  database: {
    connectionString: process.env.DATABASE_URL ||
      'postgresql://postgres.qeqrcjwvceulimfvsekk:4UlHCyoHfySwUuXY@aws-1-ap-southeast-2.pooler.supabase.com:5432/postgres',
    ssl: { rejectUnauthorized: false },
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 3000,
  },

  jwt: {
    secret:    process.env.JWT_SECRET    || 'CHANGE_ME_IN_PRODUCTION',
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  },

  rtmp: {
    localServer: process.env.RTMP_LOCAL     || 'rtmp://127.0.0.1/live',
    nginxApi:    process.env.NGINX_RTMP_API || 'http://127.0.0.1:8080/control',
  },

  srt: {
    server:      process.env.SRT_SERVER    || '127.0.0.1',
    port:        process.env.SRT_PORT      || 9999,
    mediamtxApi: process.env.MEDIAMTX_API || 'http://127.0.0.1:9997',
  },

  // Streaming platform RTMP endpoints
  platforms: {
    youtube: { rtmpBase: 'rtmp://a.rtmp.youtube.com/live2' },
    kick:    { rtmpBase: 'rtmps://fa723fc1b171.global-contribute.live-video.net:443/app' },
    twitch:  { rtmpBase: 'rtmp://live.twitch.tv/app' },
  },

  vm: {
    provider: process.env.VM_PROVIDER || 'digitalocean',
    digitalocean: {
      token:  process.env.DO_TOKEN,
      region: process.env.DO_REGION || 'sgp1',
      size:   process.env.DO_SIZE   || 's-2vcpu-4gb',
      image:  process.env.DO_IMAGE  || 'ubuntu-22-04-x64',
    },
    aws: {
      region:       process.env.AWS_REGION        || 'ap-southeast-1',
      instanceType: process.env.AWS_INSTANCE_TYPE || 't3.medium',
      amiId:        process.env.AWS_AMI_ID,
    },
  },

  admin: {
    secret: process.env.ADMIN_SECRET || 'CHANGE_ME_ADMIN_SECRET',
  },
};
