import { Link } from '@/i18n/routing';
import { getBranding } from '@/lib/branding';

/** INST-14: the instance's logo and name, linking home. */
export async function BrandMark() {
  const brand = await getBranding();
  return (
    <Link
      href="/"
      className="flex items-center gap-2 font-semibold text-lg hover:opacity-80 transition-opacity"
      style={brand.accentColor ? { color: brand.accentColor } : undefined}
    >
      {brand.logoUrl && (
        // eslint-disable-next-line @next/next/no-img-element -- any instance-hosted URL
        <img src={brand.logoUrl} alt="" className="h-6 w-auto" />
      )}
      {brand.name}
    </Link>
  );
}
