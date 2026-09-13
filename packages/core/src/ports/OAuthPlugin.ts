export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
}

export interface OAuthUserInfo {
  id: string;
  email: string;
  name?: string;
  avatarUrl?: string;
}

export interface OAuthPlugin {
  getAuthorizationUrl(state: string): string;
  exchangeCode(code: string): Promise<OAuthTokens>;
  getUserInfo(accessToken: string): Promise<OAuthUserInfo>;
}
