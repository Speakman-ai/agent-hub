export const BUCKET: string;
export const REGION: string;
export const AWS_PROFILE: string;
export const PRODUCT_NAME: string;
export function readVersion(pkgPath?: string): string;
export function readDarwinEsbuildDirVersion(root?: string): string | null;
export function readNativeDarwinEsbuildVersion(root?: string): string | null;
export function crossDarwinEsbuildPackageSpec(version: string): string;
export function dmgFilenames(productName: string, version: string): { arm64: string; x64: string };
export function s3Key(version: string, filename: string): string;
export function s3Uri(bucket: string, key: string): string;
export function resolveAwsProfile(env?: NodeJS.ProcessEnv): string | null;
export function awsCpArgs(
  profile: string | null,
  source: string,
  destination: string,
): string[];
export function electronBuilderArgs(version: string): string[];
