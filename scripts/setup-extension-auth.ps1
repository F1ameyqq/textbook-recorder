param([switch]$Force)

# Run interactively once. Never accept a token as an argument or write plaintext.
$ErrorActionPreference = 'Stop'
$secureToken = $null
$bstr = [IntPtr]::Zero
$plainBytes = $null
$tempPath = $null
try {
  if ($env:OS -ne 'Windows_NT') { throw 'Windows CurrentUser DPAPI is required.' }
  Add-Type -AssemblyName System.Security
  $storeDirectory = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'textbook-recorder'
  $storePath = Join-Path $storeDirectory 'extension-auth.dpapi.json'
  if ((Test-Path -LiteralPath $storePath) -and -not $Force) { throw 'Encrypted authorization already exists. Use -Force to replace it explicitly.' }
  $secureToken = Read-Host 'Paste PLAYWRIGHT_MCP_EXTENSION_TOKEN (hidden input)' -AsSecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
  $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  if ($plain.Length -eq 0 -or $plain.Length -gt 4096 -or $plain -notmatch '^[\x21-\x7e]+$') { throw 'Invalid extension token format; nothing saved.' }
  $plainBytes = [Text.Encoding]::UTF8.GetBytes($plain)
  $entropy = [Text.Encoding]::UTF8.GetBytes('textbook-recorder/playwright-extension-auth/v1')
  $cipher = [Security.Cryptography.ProtectedData]::Protect($plainBytes, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
  $plain = $null
  $stored = [ordered]@{ schemaVersion=1; kind='playwright-extension-auth'; algorithm='windows-dpapi'; scope='CurrentUser'; ciphertext=[Convert]::ToBase64String($cipher); createdAt=[DateTime]::UtcNow.ToString('o') }
  [IO.Directory]::CreateDirectory($storeDirectory) | Out-Null
  $tempPath = Join-Path $storeDirectory ([Guid]::NewGuid().ToString() + '.tmp')
  [IO.File]::WriteAllText($tempPath, ($stored | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
  if (Test-Path -LiteralPath $storePath) { [IO.File]::Replace($tempPath, $storePath, $null) } else { [IO.File]::Move($tempPath, $storePath) }
  $tempPath = $null
  $fileAcl = [Security.AccessControl.FileSecurity]::new()
  $fileAcl.SetAccessRuleProtection($true, $false)
  $rule = [Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.WindowsIdentity]::GetCurrent().User, 'FullControl', 'Allow')
  $fileAcl.AddAccessRule($rule)
  Set-Acl -LiteralPath $storePath -AclObject $fileAcl
  Write-Host 'Extension authorization saved with Windows CurrentUser DPAPI. Token is not displayed.'
} catch {
  # Avoid printing exception data that could contain the entered token.
  [Console]::Error.WriteLine('Authorization import failed. No token is displayed. Check Windows permissions or use -Force for an existing store.')
  exit 1
} finally {
  $plain = $null
  if ($null -ne $plainBytes) { [Array]::Clear($plainBytes, 0, $plainBytes.Length) }
  if ($bstr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
  if ($null -ne $secureToken) { $secureToken.Dispose() }
  if ($tempPath -and (Test-Path -LiteralPath $tempPath)) { Remove-Item -LiteralPath $tempPath -Force }
}
