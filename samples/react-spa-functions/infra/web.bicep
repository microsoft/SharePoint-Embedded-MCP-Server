@description('Name of the Static Web App')
param name string
param location string = resourceGroup().location
param tags object = {}

// azd matches this resource to the azure.yaml 'web' service via azd-service-name.
resource swa 'Microsoft.Web/staticSites@2023-12-01' = {
  name: name
  location: location
  tags: union(tags, { 'azd-service-name': 'web' })
  sku: { name: 'Free', tier: 'Free' }
  properties: {
    allowConfigFileUpdates: true
    provider: 'Custom'
    stagingEnvironmentPolicy: 'Enabled'
  }
}

output name string = swa.name
output uri string = 'https://${swa.properties.defaultHostname}'
