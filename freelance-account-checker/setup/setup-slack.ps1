<#
.SYNOPSIS
  Sets up Slack for Freelance Account Checker (and Job Finder): the Slack app's scopes and the channels.

.DESCRIPTION
  1. Scopes (optional; needs an App Configuration Token from https://api.slack.com/apps, "Your App
     Configuration Tokens" -> Generate Token):
       - with an App ID: adds every User Token Scope listed in slack-app-manifest.json that the app
         is missing (files:read, files:write, ...), keeping everything else in the app as it is;
       - without one: creates a new app from slack-app-manifest.json.
     Then the app's "OAuth & Permissions" page is opened: press "Reinstall to Workspace" (or
     "Install to Workspace"), allow, and copy the new User OAuth Token (xoxp-...). Slack only issues a
     token with new scopes after you approve them there, so this one click stays yours.
  2. Token: checks which of those scopes the token has (and says what a missing one is needed for),
     then for each channel in ..\sites.js (slackChannel values: lancers, coconala, crowdworks, workana,
     accounts, messages, alert, package, portfolio):
       - creates it if it doesn't exist (unarchives it if it was archived)
       - joins it so you can post there
       - optionally invites the Slack member IDs given
  Safe to run more than once: existing channels and scopes are left as they are.

  Run without parameters (or via install.cmd) to get the setup window.

.PARAMETER Token
  Slack user token (xoxp-...) from the app: checks its scopes and creates the channels.

.PARAMETER ConfigToken
  App Configuration Token (xoxe.xoxp-...): adds the missing scopes to the app (with -AppId) or creates
  the app (without).

.PARAMETER AppId
  The Slack app's ID (A0123ABCD, on the app's Basic Information page).

.PARAMETER InviteUserIds
  Slack member IDs to add to every channel, e.g. U01ABCDEF,U02GHIJKL
  (Profile -> "..." -> "Copy member ID").

.PARAMETER Private
  Create new channels as private instead of public.

.EXAMPLE
  .\setup-slack.ps1
.EXAMPLE
  .\setup-slack.ps1 -ConfigToken xoxe.xoxp-... -AppId A0123ABCD
.EXAMPLE
  .\setup-slack.ps1 -Token xoxp-... -InviteUserIds U01ABCDEF,U02GHIJKL -Private
#>
param(
  [string]$Token,
  [string]$ConfigToken,
  [string]$AppId,
  [string[]]$InviteUserIds = @(),
  [switch]$Private
)

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# What each scope is for (shown when the token lacks it).
$ScopeUse = @{
  "search:read"      = "finding messages that mention your accounts"
  "chat:write"       = "posting and deleting messages"
  "channels:read"    = "finding public channels by name"
  "channels:write"   = "creating channels (#alert, #package)"
  "groups:read"      = "finding private channels by name"
  "groups:write"     = "creating private channels"
  "channels:history" = "reading new orders and requests in public channels"
  "groups:history"   = "reading new orders and requests in private channels"
  "users:read"       = "recognising who sent an order"
  "files:read"       = "reading a package's images / video / audio / PDF (Freelance Account Checker)"
  "files:write"      = "uploading a package's images / video / audio / PDF (Job Finder)"
}

# Where progress messages go: the console by default, the window's log box in GUI mode.
$script:LogSink = {
  param($Message, $Level)
  switch ($Level) {
    "ok"    { Write-Host $Message -ForegroundColor Green }
    "warn"  { Write-Host "WARNING: $Message" -ForegroundColor Yellow }
    "error" { Write-Host "ERROR: $Message" -ForegroundColor Red }
    default { Write-Host $Message }
  }
}

function Write-Log([string]$Message, [string]$Level = "info") { & $script:LogSink $Message $Level }

# The app manifest next to this script: the scopes the extensions need.
function Get-AppManifest {
  $path = Join-Path $PSScriptRoot "slack-app-manifest.json"
  return Get-Content $path -Raw -Encoding UTF8 | ConvertFrom-Json
}

# Calls a Slack Web API method with $AuthToken. Returns the answer, with the token's scopes (from
# Slack's x-oauth-scopes header) as .scopes.
function Invoke-SlackApi([string]$Method, [hashtable]$Params = @{}, [string]$AuthToken = $script:SlackToken) {
  $res = Invoke-WebRequest -UseBasicParsing -Method Post -Uri "https://slack.com/api/$Method" `
    -Headers @{ Authorization = "Bearer $AuthToken" } `
    -ContentType "application/x-www-form-urlencoded; charset=utf-8" -Body $Params
  $data = [Text.Encoding]::UTF8.GetString($res.RawContentStream.ToArray()) | ConvertFrom-Json
  if (-not $data.ok) {
    $detail = if ($data.error -eq "missing_scope" -and $data.needed) { " (needs $($data.needed))" } else { "" }
    $errors = if ($data.errors) { ": " + (($data.errors | ForEach-Object { "$($_.pointer) $($_.message)" }) -join "; ") } else { "" }
    throw "$Method failed: $($data.error)$detail$errors"
  }
  $scopes = "$($res.Headers['x-oauth-scopes'])" -split "\s*,\s*" | Where-Object { $_ }
  $data | Add-Member -NotePropertyName scopes -NotePropertyValue @($scopes) -Force
  return $data
}

function Invoke-Slack([string]$Method, [hashtable]$Params = @{}) { Invoke-SlackApi $Method $Params $script:SlackToken }

# ---------- 1. the app's scopes ----------

function Update-SlackAppScopes([string]$ConfigToken, [string]$AppId) {
  $ConfigToken = "$ConfigToken".Trim()
  $AppId = "$AppId".Trim()
  if ($ConfigToken -notlike "xoxe*") { throw "That isn't an App Configuration Token. It starts with 'xoxe.xoxp-' (https://api.slack.com/apps -> Your App Configuration Tokens -> Generate Token)." }
  $wanted = @((Get-AppManifest).oauth_config.scopes.user)

  if (-not $AppId) {
    # No app yet: one is created from slack-app-manifest.json.
    $manifest = Get-AppManifest | ConvertTo-Json -Depth 20 -Compress
    $created = Invoke-SlackApi "apps.manifest.create" @{ manifest = $manifest } $ConfigToken
    $AppId = $created.app_id
    Write-Log "Slack app created: $AppId (scopes: $($wanted -join ', '))" "ok"
  } else {
    $current = (Invoke-SlackApi "apps.manifest.export" @{ app_id = $AppId } $ConfigToken).manifest
    if (-not $current.oauth_config) { $current | Add-Member -NotePropertyName oauth_config -NotePropertyValue ([pscustomobject]@{}) -Force }
    if (-not $current.oauth_config.scopes) { $current.oauth_config | Add-Member -NotePropertyName scopes -NotePropertyValue ([pscustomobject]@{}) -Force }
    $have = @($current.oauth_config.scopes.user)
    $missing = @($wanted | Where-Object { $have -notcontains $_ })
    if (-not $missing.Count) {
      Write-Log "The app already has every scope: $($wanted -join ', ')" "ok"
    } else {
      $current.oauth_config.scopes | Add-Member -NotePropertyName user -NotePropertyValue @(@($have | Where-Object { $_ }) + $missing) -Force
      $manifest = $current | ConvertTo-Json -Depth 20 -Compress
      Invoke-SlackApi "apps.manifest.update" @{ app_id = $AppId; manifest = $manifest } $ConfigToken | Out-Null
      Write-Log "Scopes added to the app: $($missing -join ', ')" "ok"
    }
  }

  $page = "https://api.slack.com/apps/$AppId/oauth"
  Write-Log ""
  Write-Log "Next, in the page that opens ($page):"
  Write-Log "  1. press 'Reinstall to Workspace' (or 'Install to Workspace') and Allow"
  Write-Log "  2. copy the 'User OAuth Token' (xoxp-...)"
  Write-Log "  3. paste it in step 2 below (to check it and create the channels), and into"
  Write-Log "     Freelance Account Checker (Options) and Job Finder (Settings)"
  Start-Process $page
  return $AppId
}

# ---------- 2. the token: its scopes, and the channels ----------

function Test-TokenScopes([object]$AuthTest) {
  $wanted = @((Get-AppManifest).oauth_config.scopes.user)
  $have = @($AuthTest.scopes)
  if (-not $have.Count) { Write-Log "Slack didn't say which scopes this token has - skipping the scope check." "warn"; return }
  $missing = @($wanted | Where-Object { $have -notcontains $_ })
  if (-not $missing.Count) { Write-Log "Token scopes: all $($wanted.Count) present" "ok"; return }
  Write-Log "The token is missing $($missing.Count) scope(s):" "warn"
  foreach ($scope in $missing) { Write-Log "    $scope - for $($ScopeUse[$scope])" "warn" }
  Write-Log "  Add them with step 1 (or under OAuth & Permissions -> User Token Scopes), reinstall the app and use the new token." "warn"
}

function Install-SlackChannels([string]$Token, [string[]]$InviteUserIds, [bool]$Private) {
  $Token = "$Token".Trim()
  if ($Token -notlike "xoxp-*") { throw "That isn't a user token. It must start with 'xoxp-' (User OAuth Token on the app's OAuth & Permissions page)." }
  $script:SlackToken = $Token

  # Accept "U1,U2", "U1 U2" or one per line
  $InviteUserIds = @($InviteUserIds | ForEach-Object { $_ -split "[,\s]+" } | Where-Object { $_ })

  # Channel names come from the extension's sites.js so the two never drift apart.
  $sitesFile = Join-Path $PSScriptRoot "..\sites.js"
  $channels = [regex]::Matches((Get-Content $sitesFile -Raw -Encoding UTF8), 'slackChannel:\s*"([^"]+)"') | ForEach-Object { $_.Groups[1].Value }
  if (-not $channels) { throw "No slackChannel entries found in $sitesFile" }

  $me = Invoke-Slack "auth.test"
  Write-Log "Connected as $($me.user) @ $($me.team)" "ok"
  Test-TokenScopes $me

  # Load existing channels (including archived ones) once.
  $existing = @{}
  $cursor = ""
  do {
    $page = Invoke-Slack "conversations.list" @{ types = "public_channel,private_channel"; exclude_archived = "false"; limit = "1000"; cursor = $cursor }
    foreach ($c in $page.channels) { $existing[$c.name] = $c }
    $cursor = $page.response_metadata.next_cursor
  } while ($cursor)

  Write-Log "Channels: $(($channels | ForEach-Object { "#$_" }) -join ', ')"
  foreach ($name in $channels) {
    try {
      $channel = $existing[$name]
      if (-not $channel) {
        $channel = (Invoke-Slack "conversations.create" @{ name = $name; is_private = ([string]$Private).ToLower() }).channel
        Write-Log "#$name  created" "ok"
      } else {
        if ($channel.is_archived) {
          Invoke-Slack "conversations.unarchive" @{ channel = $channel.id } | Out-Null
          Write-Log "#$name  unarchived" "ok"
        } else {
          Write-Log "#$name  already exists"
        }
        if (-not $channel.is_member) {
          if ($channel.is_private) {
            Write-Log "#$name is private and you're not a member - ask a member to invite you." "warn"
            continue
          }
          Invoke-Slack "conversations.join" @{ channel = $channel.id } | Out-Null
          Write-Log "#$name  joined"
        }
      }

      if ($InviteUserIds.Count) {
        try {
          Invoke-Slack "conversations.invite" @{ channel = $channel.id; users = ($InviteUserIds -join ",") } | Out-Null
          Write-Log "#$name  invited $($InviteUserIds -join ', ')"
        } catch {
          if ($_.Exception.Message -match "already_in_channel") { Write-Log "#$name  invitees already in channel" }
          else { Write-Log "#$name invite: $($_.Exception.Message)" "warn" }
        }
      }
    } catch {
      Write-Log "#${name}: $($_.Exception.Message)" "warn"
    }
  }

  Write-Log ""
  Write-Log "Done. Paste the same token into Freelance Account Checker (right-click its icon -> Options -> Save & test) and into Job Finder (Settings)." "ok"
}

# ---------- the window ----------

function Show-InstallDialog {
  Add-Type -AssemblyName System.Windows.Forms, System.Drawing
  [System.Windows.Forms.Application]::EnableVisualStyles()

  $form = New-Object System.Windows.Forms.Form -Property @{
    Text = "Freelance Account Checker - Slack setup"
    ClientSize = New-Object System.Drawing.Size(560, 640)
    StartPosition = "CenterScreen"
    FormBorderStyle = "FixedDialog"
    MaximizeBox = $false
    Font = New-Object System.Drawing.Font("Segoe UI", 9)
  }

  function Add-Control($control) { $form.Controls.Add($control); $control }
  function Add-Label([string]$Text, [string]$Location, [bool]$Bold = $false) {
    $label = New-Object System.Windows.Forms.Label -Property @{ Text = $Text; Location = $Location; AutoSize = $true; MaximumSize = "528,0" }
    if ($Bold) { $label.Font = New-Object System.Drawing.Font("Segoe UI", 9, [System.Drawing.FontStyle]::Bold) }
    Add-Control $label | Out-Null
  }

  # --- 1. Scopes ---
  Add-Label "1. Slack app scopes (optional - skip if the app already has them)" "16,14" $true
  Add-Label "App Configuration Token: https://api.slack.com/apps -> 'Your App Configuration Tokens' -> Generate Token (starts with xoxe.xoxp-)" "16,36"
  $configBox = Add-Control (New-Object System.Windows.Forms.TextBox -Property @{ Location = "16,70"; Size = "528,23" })
  Add-Label "App ID (Basic Information page, e.g. A0123ABCD) - leave empty to create a new app" "16,100"
  $appIdBox = Add-Control (New-Object System.Windows.Forms.TextBox -Property @{ Location = "16,120"; Size = "260,23"; Text = $AppId })
  $scopesBtn = Add-Control (New-Object System.Windows.Forms.Button -Property @{ Text = "Add scopes / create app"; Location = "364,118"; Size = "180,28" })
  Add-Label "Scopes: $(@((Get-AppManifest).oauth_config.scopes.user) -join ', ')" "16,152"

  # --- 2. Token and channels ---
  Add-Label "2. User token - check its scopes and create the channels" "16,196" $true
  Add-Label "Slack user token (xoxp-..., 'User OAuth Token' on the app's OAuth & Permissions page)" "16,218"
  $tokenBox = Add-Control (New-Object System.Windows.Forms.TextBox -Property @{ Location = "16,238"; Size = "528,23" })
  Add-Label "Member IDs to invite (optional, comma-separated, e.g. U01ABCDEF,U02GHIJKL)" "16,268"
  $inviteBox = Add-Control (New-Object System.Windows.Forms.TextBox -Property @{ Location = "16,288"; Size = "528,23" })
  $privateBox = Add-Control (New-Object System.Windows.Forms.CheckBox -Property @{ Text = "Create new channels as private"; Location = "16,318"; AutoSize = $true })
  $installBtn = Add-Control (New-Object System.Windows.Forms.Button -Property @{ Text = "Check token && create channels"; Location = "314,316"; Size = "230,28" })

  $closeBtn = Add-Control (New-Object System.Windows.Forms.Button -Property @{ Text = "Close"; Location = "456,604"; Size = "88,28"; DialogResult = "Cancel" })
  $form.CancelButton = $closeBtn

  $logBox = Add-Control (New-Object System.Windows.Forms.TextBox -Property @{
    Location = "16,356"; Size = "528,240"; Multiline = $true; ReadOnly = $true; ScrollBars = "Vertical"
  })

  $script:LogSink = {
    param($Message, $Level)
    $prefix = @{ warn = "WARNING: "; error = "ERROR: " }[$Level]
    $logBox.AppendText("$prefix$Message`r`n")
    [System.Windows.Forms.Application]::DoEvents()
  }.GetNewClosure()

  $scopesBtn.Add_Click({
    if (-not $configBox.Text.Trim()) {
      [System.Windows.Forms.MessageBox]::Show($form, "Please enter an App Configuration Token (xoxe.xoxp-...).", "Slack setup", "OK", "Warning") | Out-Null
      $configBox.Focus() | Out-Null
      return
    }
    $scopesBtn.Enabled = $false
    $logBox.Clear()
    try {
      $appIdBox.Text = Update-SlackAppScopes -ConfigToken $configBox.Text -AppId $appIdBox.Text
      $tokenBox.Focus() | Out-Null
    } catch {
      Write-Log $_.Exception.Message "error"
    } finally {
      $scopesBtn.Enabled = $true
    }
  })

  $installBtn.Add_Click({
    if (-not $tokenBox.Text.Trim()) {
      [System.Windows.Forms.MessageBox]::Show($form, "Please enter your Slack user token.", "Slack setup", "OK", "Warning") | Out-Null
      $tokenBox.Focus() | Out-Null
      return
    }
    $installBtn.Enabled = $false
    $logBox.Clear()
    try {
      Install-SlackChannels -Token $tokenBox.Text -InviteUserIds @($inviteBox.Text) -Private $privateBox.Checked
    } catch {
      Write-Log $_.Exception.Message "error"
    } finally {
      $installBtn.Enabled = $true
    }
  })

  $form.Add_Shown({ $configBox.Focus() | Out-Null })
  $form.ShowDialog() | Out-Null
  $form.Dispose()
}

if ($ConfigToken -or $Token) {
  try {
    if ($ConfigToken) { Update-SlackAppScopes -ConfigToken $ConfigToken -AppId $AppId | Out-Null }
    if ($Token) { Install-SlackChannels -Token $Token -InviteUserIds $InviteUserIds -Private $Private.IsPresent }
  } catch {
    Write-Log $_.Exception.Message "error"
    exit 1
  }
} else {
  Show-InstallDialog
}
