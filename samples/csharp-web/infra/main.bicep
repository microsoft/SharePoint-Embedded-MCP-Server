targetScope = 'subscription'

@minLength(1)
@maxLength(64)
@description('Name of the environment used to derive the resource group and resource names')
param environmentName string

@minLength(1)
@description('Primary location for all resources')
param location string

@description('Whether the web container app already exists (azd sets this on redeploys)')
param webExists bool = false

@secure()
@description('Extra app settings/secrets for the web service (azd convention)')
param webDefinition object

@description('Id of the user or service principal to assign application roles')
param principalId string = ''

@description('SharePoint Embedded container type id to surface to the app')
param speContainerTypeId string = ''

@description('Timestamp that keeps the federated Entra app uniqueName stable-yet-unique')
param deploymentTimestamp string = utcNow('yyyyMMddHHmmss')

// Tags applied to every resource. 'azd-service-name' is applied separately on the host.
var tags = {
  'azd-env-name': environmentName
}

var abbrs = loadJsonContent('./abbreviations.json')
var resourceToken = toLower(uniqueString(subscription().id, environmentName, location))

resource rg 'Microsoft.Resources/resourceGroups@2022-09-01' = {
  name: 'rg-${environmentName}'
  location: location
  tags: tags
}

module identity './shared/identity.bicep' = {
  name: 'identity'
  scope: rg
  params: {
    name: '${abbrs.managedIdentityUserAssignedIdentities}spe-${resourceToken}'
    location: location
    tags: tags
  }
}

module registry './shared/registry.bicep' = {
  name: 'registry'
  scope: rg
  params: {
    name: '${abbrs.containerRegistryRegistries}${resourceToken}'
    location: location
    tags: tags
  }
}

module appsEnv './shared/apps-env.bicep' = {
  name: 'apps-env'
  scope: rg
  params: {
    name: '${abbrs.appManagedEnvironments}${resourceToken}'
    location: location
    tags: tags
  }
}

module web './app/web.bicep' = {
  name: 'web'
  scope: rg
  params: {
    name: '${abbrs.appContainerApps}spe-${resourceToken}'
    location: location
    tags: tags
    identityName: identity.outputs.name
    containerAppsEnvironmentName: appsEnv.outputs.name
    containerRegistryName: registry.outputs.name
    exists: webExists
    appDefinition: webDefinition
    resourceToken: resourceToken
    containerTypeId: speContainerTypeId
    deploymentTimestamp: deploymentTimestamp
  }
}

output AZURE_CONTAINER_REGISTRY_ENDPOINT string = registry.outputs.loginServer
output MANAGED_IDENTITY_CLIENT_ID string = identity.outputs.clientId
output MANAGED_IDENTITY_PRINCIPAL_ID string = identity.outputs.principalId
output AZURE_CLIENT_ID string = web.outputs.appId
output SERVICE_WEB_NAME string = web.outputs.name
output SERVICE_WEB_URI string = web.outputs.uri
output AZURE_APP_UNIQUE_NAME string = web.outputs.appUniqueName

// Echoed for reference (used by azd).
output DEPLOYMENT_PRINCIPAL_ID string = principalId
