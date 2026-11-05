# Single sign-on setup

## Requirements

Single sign-on (SSO) is available on the Business and Enterprise plans. Only a workspace owner can enable SSO. Ledgerly supports SAML 2.0; OpenID Connect is not supported yet.

## Okta

In Okta, create a SAML 2.0 app integration. Set the single sign-on URL to the Assertion Consumer Service URL shown in Ledgerly under Settings > Security, and set the audience URI to the Ledgerly entity ID. Map the email attribute to user.email.

## Microsoft Entra ID

In Microsoft Entra ID (formerly Azure AD), add a non-gallery enterprise application and choose SAML. Copy the Reply URL from Ledgerly. The error AADSTS50011 means the reply URL in Entra does not exactly match the Assertion Consumer Service URL in Ledgerly; check for a missing trailing slash.

## Troubleshooting

If users see "SAML response signature invalid", upload the current signing certificate from the identity provider again. Certificates rotate yearly. Workspace owners can always sign in with their password through the recovery link if SSO is misconfigured.
