export const API_BASE = 'https://nbsmobileapi.renweb.com/api/';

export const FACTS_OAUTH = {
  issuer: 'https://accounts.renweb.com',
  authorizationEndpoint: 'https://accounts.renweb.com/connect/authorize',
  tokenEndpoint: 'https://accounts.renweb.com/connect/token',
  clientId: 'aware3', // Public client, no secret, PKCE.
  redirectUri: 'com.renweb.accounts:/oauthredirect',
  scopes: ['openid', 'aware3UserInfo', 'aware3UserConfig', 'offline_access', 'nbsMobileAppApi'],
} as const;
