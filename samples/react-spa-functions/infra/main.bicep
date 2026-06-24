targetScope = 'subscription'

@minLength(1)
@maxLength(64)
@description('Name of the environment used to derive the resource group and resource names')
param environmentName string

@minLength(1)
@description('Primary location. Azure Static Web Apps (Free) supports e.g. westus2, centralus, eastus2, westeurope, eastasia.')
param location string

var tags = { 'azd-env-name': environmentName }
var resourceToken = toLower(uniqueString(subscription().id, environmentName, location))

resource rg 'Microsoft.Resources/resourceGroups@2022-09-01' = {
  name: 'rg-${environmentName}'
  location: location
  tags: tags
}

module web './web.bicep' = {
  name: 'web'
  scope: rg
  params: {
    name: 'swa-${resourceToken}'
    location: location
    tags: tags
  }
}

output SERVICE_WEB_NAME string = web.outputs.name
output SERVICE_WEB_URI string = web.outputs.uri
