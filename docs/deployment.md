# TDB deployment


## Shell

TDB runs inside of a **shell**, source of which resides in
https:/github.com/Microsoft/TouchDevelop/ repository in `shell/` directory. The
shell is written in TypeScript (albeit an older version) and runs in
node.js.  It is capable of running one or more TDB workers (or any other piece
of JavaScript; historically it's been used for TouchDevelop scripts deployed in
the cloud). 

The JS source code of workers is fetched from Azure blob storage.  The shell
can also deploy a new version of workers into blob storage, which is then
picked up by all shell instances (there can be hundreds of them), including the
one doing the deployment. The update process if seamless --- the shell will
start a new worker, wait for it to initialize, start directing new connections
to the new worker, issue a shutdown request to the old worker, and kill it after 
3 minutes. The shell will force a restart of workers every `$TD_RESTART_INTERVAL`
seconds (typically 900, i.e., 15 minutes). The restart process is the same as update.

The shell is also capable of fetching secrets from Azure Key Vault. These are
protected by a 'master key' provided in Azure cloud configuration file. The
secrets are then passed on to the workers in form of environment variables.

One of the secrets stored in Azure Key Vault is typically the SSL certificate
of the service. HTTPS connections are handled only by the shell, the workers
never see the certificate. The workers are only handling HTTP connections
forwarded from the shell. Updating SSL certificates requires restart of 
the machine(s) running the shell (after updating the cert in key vault). 

Typically, shells are configured to run on single core machines and run only
one instance of worker.

### Creating services

Go the new Azure Portal and create the following:
* Redis Cache
* Azure Search

Both take a while to setup up, so it's good to start with that.

### Building shell

To build shell issue `jake azure` in `TouchDevelop` repo. This will create
`build/azure/tdshell.cspkg` --- a cloud package to be deployed.

### Deployment config

The service needs a `.cscfg` file for deployment. For example:


```xml
<?xml version="1.0" encoding="utf-8"?>
<ServiceConfiguration 
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" 
  xmlns:xsd="http://www.w3.org/2001/XMLSchema"
  xmlns="http://schemas.microsoft.com/ServiceHosting/2008/10/ServiceConfiguration"
  serviceName="myservice" osFamily="4" osVersion="*" 
  >
  <Role name="ShellRole">
    <ConfigurationSettings>
      <Setting name="TD_BLOB_DEPLOY_CHANNEL" value="current" />
      <Setting name="TD_DEPLOYMENT_KEY" value="AbC3frE6O3u0r12BXezRldBzui333u8u8JOsS4" />

      <Setting name="ZIP_URL" value="https://mbitx.blob.core.windows.net/files/pkg4.zip" />

      <Setting name="KEY_VAULT_CLIENT_ID" value="782abcde-8812-4242-12ed-e9282ceedaab" />
      <Setting name="KEY_VAULT_CLIENT_SECRET" value="262QV/1ikZEpGOs4jCagV3ekiIRFyX1T54FkS44ODp8=" />
      <Setting name="KEY_VAULT_URL" value="https://myservice.vault.azure.net/secrets/env" />

      <Setting name="AZURE_STORAGE_ACCOUNT" value="" />
      <Setting name="AZURE_STORAGE_ACCESS_KEY" value="" />
      <Setting name="TD_HTTPS_PFX" value="" />
    </ConfigurationSettings>
    <Instances count="2" />
    <Certificates />
  </Role>

  <NetworkConfiguration>
    <AddressAssignments>
      <ReservedIPs>
       <ReservedIP name="myserviceProd"/>
      </ReservedIPs>
    </AddressAssignments>
  </NetworkConfiguration>
</ServiceConfiguration>
```

The ``<NetworkConfiguration>`` section contains the name of your reserved IP,
see below.

``TD_BLOB_DEPLOY_CHANNEL`` is used when there is for example beta and production
deployment - they would sit on different channels. 

``TD_DEPLOYMENT_KEY`` should be long random string and is used when making
management calls against the shell (for example, deploying new versions of
workers). You can use the following command to generate this:

```bash
node -p 'require("crypto").randomBytes(30).toString("base64").replace(/[^\w]/g, "")'
```

``ZIP_URL`` should contain `node.msi` with appropriate, 32-bit version of
node.js. It can also contain folder ``node_modules`` with pre-installed modules.
While optional, it's a good idea to package all the needed modules there,
especially when deploying tens of machines---otherwise there might be problems
with npm throttling.

``KEY_VAULT_CLIENT_ID`` and ``KEY_VAULT_CLIENT_SECRET`` should let the shell read
``KEY_VAULT_URL``. 

To set up a key vault follow 
[Azure instructions](https://azure.microsoft.com/en-gb/documentation/articles/key-vault-get-started/).
You can skip the 'Add a key or secret to the key vault' part.
You will need to authorize your AD app for read/write access to secrets (but none to keys).
In particular, where the tutorial says `-PermissionsToSecrets Get` instead
use `-PermissionsToSecrets Get,Set`. After granting permission, you can stop
following the steps - no need to HSM or deleting anything.

The ``KEY_VAULT_URL`` should point to a JSON file in the Azure Key Vault. The JSON
file has ``string->string`` mapping defining environment variables.
It can be uploaded by running shell from command line, or using PowerShell. 
Typically, you would create `putsecret.sh` file, with something like this:

```bash
#!/bin/sh
export KEY_VAULT_CLIENT_ID="782abcde-8812-4242-12ed-e9282ceedaab"
export KEY_VAULT_CLIENT_SECRET="262QV/1ikZEpGOs4jCagV3ekiIRFyX1T54FkS44ODp8="
export KEY_VAULT_URL="https://myservice.vault.azure.net/secrets/env"
export TD_BLOB_DEPLOY_CHANNEL=test
export SELF=http://localhost:4242/
export LOG_TAG=mbitlocal
export MAIN_RELEASE_NAME=latest
node shell.js --putsecret env.json
```

You then create `env.json` and run `./putsecret.sh` after every edit. Note,
that you either need to wait 15 minutes for workers to be restarted, or
restart them using `remote.js`. When running TDB locally, you can pass
`env.json` as an argument.

The ``AZURE_STORAGE_ACCOUNT`` and friends are not used when using Azure Key
Vault. They have to be present in the XML file though (otherwise deployment
will fail).

### Creating env.json

You can take ``env.json`` from an existing deployment. You will then need to
do the following updates:
* replace ``TOKEN_SECRET``, and ``LOGIN_SECRET`` with fresh random strings
* replace ``MBEDINT_KEY`` with a random string --- this can later be used to
setup cloud build service
* ``TDC_*`` variables are only needed for Touch Develop-based deployments
* update ``REDIS_HOST`` and ``REDIS_SECRET`` with a freshly created redis
  instance
* update ``AZURE_SEARCH_SERVICE_NAME`` and ``AZURE_SEARCH_API_KEY`` with the
  credentials of freshly created search service
* either create a CDN endpoint, and set ``CDN_URL``, or use main blob storage
  account URL as the CDN url; note that there is no slash at the end of this URL
* you can re-fresh ``ENCKEY_*`` variables; but if you're restoring backup don't
* depending on chosen domain name, you may need to update ``TD_HTTPS_PFX``,
  see [SSL certs](ssl.md)

### Deploying shell


First, select login or import the management certificate and select the right
subscription with ``Set-AzureSubscription -SubscriptionName  '...'``

Next, create the main cloud service:

```powershell
New-AzureService myservice -Location "East US"
```

You'll need to reserve at least two IPs, one for production and one for staging.

```powershell
New-AzureReservedIP –ReservedIPName myserviceProd –Location "East US"
New-AzureReservedIP –ReservedIPName myserviceStage –Location "East US"
```

Next, deploy the shell:

```powershell
New-AzureDeployment -ServiceName myservice -Package c:\touchdevelop\build\azure\tdshell.cspkg -Configuration C:\somewhere\safe\myservice.cscfg -Slot Production
```

In future, you will want to deploy to ``Staging`` and swap after you see it's
working. When you do that, you will also need to put ``myserviceStage`` reserved
IP in the `.cscfg` file.

Point your DNS to the ``myserviceProd`` IP. For temporary testing, you can add
the following line to your ``/etc/hosts` or ``C:\Windows\System32\drivers\etc\hosts``:

```
42.42.108.108   test.myservice.com
```

where ``42.42.108.108`` is your reserved production IP and ``test.myservice.com`` 
is the name you have the certificate for (e.g., it could ``*.myservice.com`` certificate).


## remote.js

`remote.js` is used to access management APIs of the shell. Typically, you
will create a `remote.sh` in root directory of this repo with something like
this:


```bash
#!/bin/sh
TD_UPLOAD_TARGET=https://myservice.com/-tdevmgmt-/AbC3frE6O3u0r12BXezRldBzui333u8u8JOsS4 \
node built/remote.js "$@"
```

The string after `/-tdevmgmt-/` is the `TD_DEPLOYMENT_KEY` from the `.cscfg`
file. You can even talk to the shell over HTTP --- the connection will be
encrypted using `TD_DEPLOYMENT_KEY`.

When you run `remote.sh` with no arguments it displays help:


```
$ ./remote.sh
usage: node remote.js command
Commands:
deploy                deploy JS files
shell                 see shell logs
log                   see application logs
stats                 see various shell stats
restart               restart worker (poke the config)
getenv                fetch current environment config
setenv file|VAR=val   set current environment config
worker PATH [DATA]    forward to one worker
```

When you run `./remote.sh shell` or `./remote.sh log` you need
to pipe the result to `more` (or `less`), otherwise you only get about one
screen. `shell` logs are particularly useful when the workers don't start.
Application logs are more high-level. They are also piped to loggly.
Note, that if you have more than one cloud service instance it can take a few tries
until you hit the right one with `shell` or `log`.

`getenv` and `setenv` commands are used to set additional variables,
in addition to the ones from `env.json` described above. Typically, when there
is beta and production environment they will share `env.json` and then
override variables like `SELF` using `setenv`. You should not use
`setenv` to store anything sensitive.

## Storage accounts

A TDB instances uses several storage accounts. If your service is named `foo`
the following storage accounts are used:

* foo - main storage account that contains most of the publication data
* fooaudit - tables and blobs with audit logs (may contain encrypted IPs,
  records of deletion etc)
* foostreams - streaming data, see [streams.md]
* foobackup - used for backup of all the other accounts, see below

The following are used in TD but not in PXT:

* foowstab - tables storing pointers to the current state of all user's workspaces
* foohist - tables storing pointers to the previous versions of all user's workspaces
* foows0, foows1, foows2, and foows3 - blobs containing user's workspaces;
  this is divided by the last letter of user's ID modulo 4
* foonot - tables storing notifications for users
* foocompile - not used anymore

These accounts can be all created using `scripts/mkaccounts.sh`. You
need to edit this file before executing to replace `foo` with your service
name and pick the right region for your storage accounts.

You will also need `azure-cli` npm package, and authenticate in it.

Running this script will (after a few minutes, creating accounts takes time)
create two files `envadd.json` to add to `env.json` mentioned above
and also `accounts.json` which is useful when restoring backup.


## Backup

Backup script in `backup-script/backup.js` copies data from a number of the storage
accounts used by TDB instance, to a single backup account. The data is stored in
compressed and encrypted form. 

Backup script is run from a Linux virtual machine, usually in the same data center
as the storage accounts. It can be run from a separate subscription for added security.
Backup script has to have full access to instance storage accounts, even though
it only uses read access.

Backup script does not look into Redis or Azure Search. In fact, Redis is treated purely
as cache and can be fully flushed at any time without much effect on a running TDB instance.
Azure Search index can be re-created from storage.

### Setting up backup

* provision a Ubuntu server virtual machine
* git clone the TouchDevelop-backend repo into home directory of a user (doesn't have to be privileged user) 
* create symlink: `cd; ln -s TouchDevelop-backend/backup-script/ bkp`
* setup `~/bkp/envbkp.json` with the following:
```json
{
    "KEY_VAULT_CLIENT_ID": "782abcde-8812-4242-12ed-e9282ceedaab",
    "KEY_VAULT_CLIENT_SECRET": "262QV/1ikZEpGOs4jCagV3ekiIRFyX1T54FkS44ODp8=",
    "KEY_VAULT_URL": "https://myservice.vault.azure.net/secrets/env",
    "BACKUP_ACCOUNT": "myservicebkp",
    "BACKUP_KEY": "Q0QCMXEbPZ9nbjF4YMYUgdm4F9n9pATRmS1i0SoAEmnC0vBFoKNc7SrYwdzmPH7r3XPqRgi6euey8Jmd4rR6ow==",
    "ENCKEY_BACKUP0": "someRandomString"
}
```
* do a `cd ~/bkp; mkdir logs; ./go.sh` and see if it all works
* put the following line in user's crontab (by running `crontab -e`) to run the backup daily at 4:42 am
```
42 4 * * * $HOME/bkp/cron.sh
```

### Restoring backup

First, take `accounts.json` file created using `mkaccounts.sh` and add it to `~/bkp/envbkp.json`,
like this (leaving the previous content in):

```json
{
    ...
    "accounts": {
      "foo": "YTOFalp1peDySsMAZ9LXjiN566yCzjM310yFks+TZb+5QjRgtRuntGoR4PzUOk71HURK/tnBE7me+jmVYVf26A==",
      "foows0": "4f+yR/OLPjD730lh2D2XYovL33QUeMYP8x9fMpnEUktmY1Dya+ye3/plefP41ZwPxc9nR6QG7WMsCen06Rg2cg==",
      ...
    }
}
```

Make sure you these are empty accounts you're adding under `accounts`. They
will be overwritten.

Run the following in `~/bkp`:
```
RESTORE_BACKUP=foo node backup.js < envbkp.json
```

### Backup retention

The backup script will keep at least 30 previous backups. It will also 
not delete more than 5 old backups at a time.

The backup process is somewhat incremental, in that is uses previous backup
to speed up creating the current one. However, every backup (i.e., storage
container in `foobackup` account) contains the full information.

Full TouchDevelop cloud backup takes about 50GB.

