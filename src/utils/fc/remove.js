
const FcFunction = require('./function')
const FcTrigger = require('./trigger')
const { FUN_NAS_FUNCTION } = require('../nas/nas')
const { yellow, red } = require('colors')
const nas = require('../nas/nas')
const { sleep } = require('../common')
const { findDefaultVpcAndSwitch } = require('../vpc')
const Logs = require('../logs')

class Remove {
  constructor (commands = {}, parameters = {}, {
    credentials = {}, serviceName = '', serviceProp = {}, functionName = '', functionProp = {}, region = ''
  } = {}) {
    this.commands = commands
    this.parameters = parameters
    this.credentials = credentials
    this.serviceName = serviceName
    this.serviceProp = serviceProp
    this.functionName = functionName
    this.functionProp = functionProp
    this.region = region
  }

  async removeNasFunctionIfExists (serviceName) {
    const fcFunction = new FcFunction(this.credentials, this.region)
    const existsNasFunction = await fcFunction.functionExists(serviceName, FUN_NAS_FUNCTION)
    if (!existsNasFunction) {
      return
    }

    const fcTrigger = new FcTrigger(this.credentials, this.region)
    try {
      await fcTrigger.remove(serviceName, FUN_NAS_FUNCTION)
    } catch (e) {
      console.log(yellow(`Unable to remove trigger for ${FUN_NAS_FUNCTION}`))
    }

    try {
      await fcFunction.remove(serviceName, FUN_NAS_FUNCTION)
      console.log(`Remove function for NAS successfuly: ${FUN_NAS_FUNCTION}`)
    } catch (e) {
      console.log(yellow(`Unable to remove function: ${FUN_NAS_FUNCTION}`))
    }
  }

  async removeAutoGeneratedResourceIfExists () {
    // handle nas
    const nasConfig = this.serviceProp.Nas
    if (this.isConfigAsAuto(nasConfig)) {
      const {vpcId, vswitchId} = await findDefaultVpcAndSwitch(this.credentials, this.region)
      if (vpcId && vswitchId) {
        try {
          await nas.deleteDefaultNasIfExist(this.credentials, this.region, vpcId, vswitchId)
        } catch (e) {
          console.log(yellow(`Failed to delete auto generated nas: ${e}`))
        }
      }
    }

    //handle sls
    const logConfig = this.serviceProp.Log
    if (this.isConfigAsAuto(logConfig)) {
      const logs = new Logs(this.credentials, this.region, false)
      if (await logs.defaultSlsProjectExist()) {
        try {
          await logs.deleteDefaultSlsProject()
        } catch (e) {
          console.log(yellow(`Failed to delete auto generated sls project: ${e}`))
        }
      }
    }
  }

  isConfigAsAuto (config) {
    return config && typeof config === 'string' && config.toLocaleLowerCase() === 'auto'
  }
}

module.exports = Remove
