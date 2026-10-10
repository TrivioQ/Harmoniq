import { randomBytes } from 'crypto';
import { inflateRawSync } from 'zlib';
import { SignedXml } from 'xml-crypto';
import selfsigned from 'selfsigned';

export const IDP = 'https://idp.example.test';
const C14N = 'http://www.w3.org/2001/10/xml-exc-c14n#';

/** A test SAML IdP: its signing keypair and signed responses for an SP's ACS. */
export function mockSamlIdp() {
  const pems = selfsigned.generate([{ name: 'commonName', value: 'test-idp' }], {
    days: 30,
    keySize: 2048,
    algorithm: 'sha256',
  });
  const idpKey = pems.private;
  const idpCert = pems.cert;

  /** A signed SAML response from the test IdP to the SP at `sp`. */
  function response(
    sp: { acs: string; entityId: string },
    opts: {
      email: string;
      groups?: string[];
      inResponseTo?: string;
      audience?: string;
    }
  ) {
    const now = new Date();
    const later = new Date(now.getTime() + 5 * 60_000).toISOString();
    const before = new Date(now.getTime() - 60_000).toISOString();
    const irt = opts.inResponseTo ? ` InResponseTo="${opts.inResponseTo}"` : '';
    const groups = (opts.groups ?? [])
      .map((g) => `<saml:AttributeValue>${g}</saml:AttributeValue>`)
      .join('');
    const xml =
      `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_r${randomBytes(8).toString('hex')}" Version="2.0" IssueInstant="${now.toISOString()}" Destination="${sp.acs}"${irt}>` +
      `<saml:Issuer>${IDP}</saml:Issuer>` +
      `<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>` +
      `<saml:Assertion ID="_a${randomBytes(8).toString('hex')}" Version="2.0" IssueInstant="${now.toISOString()}">` +
      `<saml:Issuer>${IDP}</saml:Issuer>` +
      `<saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${opts.email}</saml:NameID>` +
      `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData NotOnOrAfter="${later}" Recipient="${sp.acs}"${irt}/></saml:SubjectConfirmation></saml:Subject>` +
      `<saml:Conditions NotBefore="${before}" NotOnOrAfter="${later}"><saml:AudienceRestriction><saml:Audience>${opts.audience ?? sp.entityId}</saml:Audience></saml:AudienceRestriction></saml:Conditions>` +
      `<saml:AuthnStatement AuthnInstant="${now.toISOString()}" SessionIndex="_s1"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:Password</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>` +
      `<saml:AttributeStatement><saml:Attribute Name="mail"><saml:AttributeValue>${opts.email}</saml:AttributeValue></saml:Attribute><saml:Attribute Name="memberOf">${groups}</saml:Attribute></saml:AttributeStatement>` +
      `</saml:Assertion></samlp:Response>`;
    const sig = new SignedXml({
      privateKey: idpKey,
      publicCert: idpCert,
      canonicalizationAlgorithm: C14N,
      signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
    });
    sig.addReference({
      xpath: "//*[local-name(.)='Assertion']",
      transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', C14N],
      digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
    });
    sig.computeSignature(xml, {
      location: {
        reference: "//*[local-name(.)='Assertion']/*[local-name(.)='Issuer']",
        action: 'after',
      },
    });
    return sig.getSignedXml();
  }

  return { cert: idpCert, response };
}

/** The AuthnRequest ID in an SP-initiated redirect. */
export const requestIdOf = (authorizationUrl: string) => {
  const raw = new URL(authorizationUrl).searchParams.get('SAMLRequest')!;
  const xml = inflateRawSync(Buffer.from(raw, 'base64')).toString();
  return /ID="([^"]+)"/.exec(xml)![1];
};
