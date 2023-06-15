$BaseDir = "C:\Steffest\Dropbox"
$NameToFind = "node_modules"

echo "Scanning $BaseDir for $NameToFind"

Get-ChildItem $BaseDir -Directory -Recurse | Where-Object {
  $_.Name.EndsWith($NameToFind)
} | ForEach-Object { Set-Content -Path $_.FullName -Stream com.dropbox.ignored -Value 1 }

echo "Done"