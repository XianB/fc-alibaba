'use strict'

const _ = require('lodash')

const fs = require('fs-extra')
const path = require('path')
const debug = require('debug')('fun:deploy')
const zip = require('../zip')
const vpc = require('../vpc')
const nas = require('../nas/nas')
const RAM = require('../ram')
const Logs = require('../logs')
const Client = require('./client')
const definition = require('../tpl/definition')

const { sleep } = require('../common')
const { promiseRetry } = require('../common')
const { green, red, yellow } = require('colors')
const { DEFAULT_VPC_CONFIG, DEFAULT_NAS_CONFIG, FUN_GENERATED_SERVICE } = require('./static')

const FIVE_SPACES = '     '
const EXTREME_PATH_PREFIX = '/share'

class Service extends Client {
  constructor (credentials, region) {
    super(credentials, region)
    this.fcClient = this.buildFcClient()
    this.ram = new RAM(credentials)
  }

  /**
   * Remove service
   * @param {*} serviceName
   */
  async remove (serviceName) {
    try {
      console.log(`Deleting service ${serviceName}`)
      await this.fcClient.deleteService(serviceName)
      console.log(`Delete service ${serviceName} successfully`)
    } catch (err) {
      throw new Error(`Unable to delete function ${serviceName}: ${err.message}`)
    }
  }

  extractFcRole (role) {
    const [, , , , path] = role.split(':')
    const [, roleName] = path.split('/')
    return roleName
  }

  mapMountPointDir (mountPoints, func) {
    let resolvedMountPoints = _.map(mountPoints, (mountPoint) => {
      const serverAddr = mountPoint.ServerAddr

      const index = _.lastIndexOf(serverAddr, ':')
      if (index >= 0) {
        const mountPointDomain = serverAddr.substring(0, index)
        const remoteDir = serverAddr.substring(index + 1)
        const mountDir = mountPoint.MountDir

        debug('remoteDir is: %s', remoteDir)

        return func(mountPointDomain, remoteDir, mountDir)
      }
    })

    resolvedMountPoints = _.compact(resolvedMountPoints)

    return resolvedMountPoints
  }

  checkMountPointDomainIsExtremeNas (mountPointDomain, remoteDir) {
    const isExtremeNAS = mountPointDomain.indexOf('.extreme.nas.aliyuncs.com') !== -1

    if (isExtremeNAS && (remoteDir !== EXTREME_PATH_PREFIX && !remoteDir.startsWith(EXTREME_PATH_PREFIX + '/'))) {
      throw new Error('Extreme nas mount point must start with /share. Please refer to https://nas.console.aliyun.com/#/extreme for more help.')
    }

    return isExtremeNAS
  }

  async getFcUtilsFunctionCode (filename) {
    return await fs.readFile(path.join(__dirname, '..', 'nas', filename))
  }

  async makeFcUtilsService (role, vpcConfig, nasConfig) {
    return await this.makeService({
      serviceName: FUN_GENERATED_SERVICE,
      role,
      description: 'generated by Funcraft',
      vpcConfig,
      nasConfig
    })
  }

  async makeFcUtilsFunction ({
    serviceName,
    functionName,
    codes,
    description = '',
    handler,
    timeout = 60,
    memorySize = 128,
    runtime = 'nodejs8'
  }) {
    var fn
    try {
      fn = await this.fcClient.getFunction(serviceName, functionName)
    } catch (ex) {
      if (ex.code !== 'FunctionNotFound') {
        throw ex
      }
    }

    const base64 = await zip.packFromJson(codes)

    const code = {
      zipFile: base64
    }

    const params = {
      description,
      handler,
      initializer: '',
      timeout,
      memorySize,
      runtime,
      code
    }

    if (!fn) {
      // create
      params.functionName = functionName
      fn = await this.fcClient.createFunction(serviceName, params)
    } else {
      // update
      fn = await this.fcClient.updateFunction(serviceName, functionName, params)
    }

    return fn
  }

  async makeFcUtilsFunctionNasDirChecker (role, vpcConfig, nasConfig) {
    await this.makeFcUtilsService(role, vpcConfig, nasConfig)

    const functionName = 'nas_dir_checker'

    const functionCode = await this.getFcUtilsFunctionCode('nas-dir-check.js')

    const codes = {
      'index.js': functionCode
    }

    await this.makeFcUtilsFunction({
      serviceName: FUN_GENERATED_SERVICE,
      functionName: 'nas_dir_checker',
      codes,
      description: 'used for fun to ensure nas remote dir exist',
      handler: 'index.handler'
    })

    return functionName
  }

  async invokeFcUtilsFunction ({
    functionName,
    event
  }) {
    const rs = await this.fcClient.invokeFunction(FUN_GENERATED_SERVICE, functionName, event, {
      'X-Fc-Log-Type': 'Tail'
    })

    if (rs.data !== 'OK') {
      const log = rs.headers['x-fc-log-result']

      if (log) {
        const decodedLog = Buffer.from(log, 'base64')
        if ((decodedLog.toString().toLowerCase()).includes('permission denied')) {
          throw new Error(`fc utils function ${functionName} invoke error, error message is: ${decodedLog}\n` +
          `${red('May be UserId and GroupId in NasConfig don\'t have enough\n' +
          'permission, more information please refer to https://github.com/alibaba/funcraft/blob/master/docs/usage/faq-zh.md')}`)
        }
        throw new Error(`fc utils function ${functionName} invoke error, error message is: ${decodedLog}`)
      }
    }
  }

  async ensureNasDirExist ({ role, vpcConfig, nasConfig }) {
    const mountPoints = nasConfig.MountPoints
    const modifiedNasConfig = _.cloneDeep(nasConfig)

    modifiedNasConfig.MountPoints = this.mapMountPointDir(mountPoints, (mountPointDomain, remoteDir, mountDir) => {
      if (this.checkMountPointDomainIsExtremeNas(mountPointDomain, remoteDir)) {
        // 极速 nas
        return {
          ServerAddr: `${mountPointDomain}:${EXTREME_PATH_PREFIX}`,
          MountDir: `${mountDir}`
        }
      } else if (remoteDir !== '/') {
        return {
          ServerAddr: `${mountPointDomain}:/`,
          MountDir: `${mountDir}`
        }
      } return null
    })

    const nasMountDirs = this.mapMountPointDir(mountPoints, (mountPointDomain, remoteDir, mountDir) => {
      if (this.checkMountPointDomainIsExtremeNas(mountPointDomain, remoteDir)) {
        if (remoteDir !== EXTREME_PATH_PREFIX) {
          return { mountDir, remoteDir, isExtreme: true }
        }
      } else if (remoteDir !== '/') {
        return { mountDir, remoteDir, isExtreme: false }
      }
      return null
    })

    debug('dirs need to check: %s', nasMountDirs)

    if (!_.isEmpty(nasMountDirs)) {
      const nasRemoteDirs = []
      const nasDirsNeedToCheck = []
      for (const nasMountDir of nasMountDirs) {
        nasRemoteDirs.push(nasMountDir.remoteDir)
        if (nasMountDir.isExtreme) {
          // 002aab55-fbdt.cn-hangzhou.extreme.nas.aliyuncs.com:/share
          nasDirsNeedToCheck.push(path.posix.join(nasMountDir.mountDir, nasMountDir.remoteDir.substring(EXTREME_PATH_PREFIX.length)))
        } else {
          nasDirsNeedToCheck.push(path.posix.join(nasMountDir.mountDir, nasMountDir.remoteDir))
        }
      }

      console.log(`\tChecking if nas directories ${nasRemoteDirs} exists, if not, it will be created automatically`)

      const utilFunctionName = await this.makeFcUtilsFunctionNasDirChecker(role, vpcConfig, modifiedNasConfig)
      await sleep(1000)
      await this.invokeFcUtilsFunction({
        functionName: utilFunctionName,
        event: JSON.stringify(nasDirsNeedToCheck)
      })

      console.log(green('\tChecking nas directories done', JSON.stringify(nasRemoteDirs)))
    }
  }

  async deployPolicy (resourceName, roleName, policy, curCount, product = 'Fc') {
    if (typeof policy === 'string') {
      await this.ram.attachPolicyToRole(policy, roleName)
      return curCount
    }

    const policyName = this.ram.normalizeRoleOrPoliceName(`Aliyun${product}GeneratedServicePolicy-${this.region}-${resourceName}${curCount}`)

    await this.ram.makeAndAttachPolicy(policyName, policy, roleName)

    return curCount + 1
  }

  async deployPolicies (resourceName, roleName, policies, product) {
    let nextCount = 1

    if (Array.isArray(policies)) {
      for (const policy of policies) {
        nextCount = await this.deployPolicy(resourceName, roleName, policy, nextCount, product)
      }
    } else {
      nextCount = await this.deployPolicy(resourceName, roleName, policies, nextCount, product)
    }
  }

  printAttachPolicyLog (policyName, roleName) {
    console.log(`${FIVE_SPACES}attached police ${yellow(policyName)} to role: ` + roleName)
  }

  async generateServiceRole ({
    serviceName, vpcConfig, nasConfig,
    logConfig, roleArn, policies, region,
    hasFunctionAsyncConfig,
    hasCustomContainerConfig
  }) {
    let role
    let roleName
    let createRoleIfNotExist = false

    const attachedPolicies = []

    if (_.isNil(roleArn)) {
      roleName = 'ServerlessToolDefaultRole'
      roleName = this.ram.normalizeRoleOrPoliceName(roleName)
      createRoleIfNotExist = true
    } else {
      try {
        roleName = this.extractFcRole(roleArn)
      } catch (ex) {
        throw new Error('The role you provided is not correct. You must provide the correct role arn.')
      }
    }

    // if roleArn has been configured, dont need `makeRole`, because `makeRole` need ram permissions.
    // However, in some cases, users do not want to configure ram permissions for ram users.
    // https://github.com/aliyun/fun/issues/182
    // https://github.com/aliyun/fun/pull/223
    if (!roleArn && (policies || !_.isEmpty(vpcConfig) || !_.isEmpty(logConfig) || !_.isEmpty(nasConfig))) {
      // create role
      console.log(`${FIVE_SPACES}make sure role '${roleName}' is exist...`)
      role = await this.ram.makeRole(roleName, createRoleIfNotExist)
      console.log(green(`${FIVE_SPACES}role '${roleName}' is already exist`))
    }

    if (!roleArn && policies) { // if roleArn exist, then ignore polices
      await this.deployPolicies(serviceName, roleName, policies)
      attachedPolicies.push(...(_.isString(policies) ? [policies] : policies))
    }

    if (!roleArn && hasFunctionAsyncConfig) {
      await this.ram.attachPolicyToRole('AliyunFCInvocationAccess', roleName)
      attachedPolicies.push('AliyunFCInvocationAccess')

      const mnsPolicyName = this.ram.normalizeRoleOrPoliceName(`AliyunFcGeneratedMNSPolicy-${this.region}-${serviceName}`)
      await this.ram.makeAndAttachPolicy(mnsPolicyName, {
        Version: '1',
        Statement: [{
          Action: [
            'mns:SendMessage',
            'mns:PublishMessage'
          ],
          Resource: '*',
          Effect: 'Allow'
        }]
      }, roleName)
    }

    if (!roleArn && (!_.isEmpty(vpcConfig) || !_.isEmpty(nasConfig))) {
      await this.ram.attachPolicyToRole('AliyunECSNetworkInterfaceManagementAccess', roleName)
      attachedPolicies.push('AliyunECSNetworkInterfaceManagementAccess')
    }

    if (!roleArn && hasCustomContainerConfig) {
      await this.ram.attachPolicyToRole('AliyunContainerRegistryReadOnlyAccess', roleName)
      attachedPolicies.push('AliyunContainerRegistryReadOnlyAccess')
    }

    if (logConfig.LogStore && logConfig.Project) {
      if (!roleArn) {
        const logPolicyName = this.ram.normalizeRoleOrPoliceName(`AliyunFcGeneratedLogPolicy-${region}-${serviceName}`)
        await this.ram.makeAndAttachPolicy(logPolicyName, {
          Version: '1',
          Statement: [{
            Action: [
              'log:PostLogStoreLogs'
            ],
            Resource: `acs:log:*:*:project/${logConfig.Project}/logstore/${logConfig.LogStore}`,
            Effect: 'Allow'
          }]
        }, roleName)
      }
    } else if (logConfig.LogStore || logConfig.Project) {
      throw new Error('LogStore and Project must both exist')
    } else if (definition.isLogConfigAuto(logConfig)) {
      if (!roleArn) {
        await this.ram.attachPolicyToRole('AliyunLogFullAccess', roleName)
        attachedPolicies.push('AliyunLogFullAccess')
      }
    }

    if (!_.isEmpty(attachedPolicies)) { this.printAttachPolicyLog(JSON.stringify(attachedPolicies), roleName) }

    return ((role || {}).Role || {}).Arn || roleArn || ''
  }

  isSlsNotExistException (e) {
    return e.code === 'InvalidArgument' &&
      _.includes(e.message, 'not exist') &&
      (_.includes(e.message, 'logstore') || _.includes(e.message, 'project'))
  }

  // make sure sls project and logstore is created
  async retryUntilSlsCreated (serviceName, options, create) {
    let slsRetry = 0
    const retryTimes = 12
    let service
    do {
      try {
        if (create) {
          debug('create service %s, options is %j', serviceName, options)
          service = await this.fcClient.createService(serviceName, options)
        } else {
          debug('update service %s, options is %j', serviceName, options)
          service = await this.fcClient.updateService(serviceName, options)
        }
        return service
      } catch (e) {
        if (this.isSlsNotExistException(e)) {
          slsRetry++

          if (slsRetry >= retryTimes) {
            throw e
          }

          await sleep(3000)
        } else { throw e }
      }
    } while (slsRetry < retryTimes)
  }

  async makeService ({
    serviceName,
    role,
    description,
    internetAccess = true,
    logConfig = {},
    vpcConfig,
    nasConfig
  }) {
    let service
    await promiseRetry(async (retry, times) => {
      try {
        service = await this.fcClient.getService(serviceName)
      } catch (ex) {
        if (ex.code === 'AccessDenied' || !ex.code || ex.code === 'ENOTFOUND') {
          if (ex.message.indexOf('FC service is not enabled for current user') !== -1) {
            console.error(red('\nFC service is not enabled for current user. Please enable FC service before using fun.\nYou can enable FC service on this page https://www.aliyun.com/product/fc .\n'))
          } else {
            console.error(red('\nThe accountId you entered is incorrect. You can only use the primary account id, whether or not you use a sub-account or a primary account ak. You can get primary account ID on this page https://account.console.aliyun.com/#/secure .\n'))
          }
          throw ex
        } else if (ex.code !== 'ServiceNotFound') {
          debug('error when getService, serviceName is %s, error is: \n%O', serviceName, ex)

          console.log(red(`\tretry ${times} times`))
          retry(ex)
        }
      }
    })

    const logs = new Logs(this.credentials, this.region, false)
    const resolvedLogConfig = await logs.transformLogConfig(logConfig)

    const options = {
      description,
      role,
      logConfig: resolvedLogConfig
    }

    if (internetAccess !== null) {
      // vpc feature is not supported in some region
      Object.assign(options, {
        internetAccess
      })
    }

    const isNasAuto = definition.isNasAutoConfig(nasConfig)
    const isVpcAuto = definition.isVpcAutoConfig(vpcConfig)

    if (!_.isEmpty(vpcConfig) || isNasAuto) {
      if (isVpcAuto || (_.isEmpty(vpcConfig) && isNasAuto)) {
        console.log(`${FIVE_SPACES}using 'Vpc: Auto', try to generate related vpc resources automatically`)
        vpcConfig = await vpc.createDefaultVpcIfNotExist(this.credentials, this.region)
        console.log(green(`${FIVE_SPACES}generated default Vpc config done:`, JSON.stringify(vpcConfig)))

        debug('generated vpcConfig: %j', vpcConfig)
      }
    }

    Object.assign(options, {
      vpcConfig: vpcConfig || DEFAULT_VPC_CONFIG
    })

    if (isNasAuto) {
      const vpcId = vpcConfig.vpcId || vpcConfig.VpcId
      const vswitchIds = vpcConfig.vswitchIds || vpcConfig.VSwitchIds

      console.log(`${FIVE_SPACES}using 'Nas: Auto', Fun will try to generate related nas file system automatically`)
      nasConfig = await nas.generateAutoNasConfig(this.credentials, this.region, serviceName, vpcId, vswitchIds, nasConfig.UserId, nasConfig.GroupId)
      console.log(green(`${FIVE_SPACES}generated auto NasConfig done: `, JSON.stringify(nas.transformClientConfigToToolConfig(nasConfig))))
    } else {
      // transform nas config from tool format to fc client format
      nasConfig = nas.transformToolConfigToFcClientConfig(nasConfig)
    }

    Object.assign(options, {
      nasConfig: nasConfig || DEFAULT_NAS_CONFIG
    })

    await promiseRetry(async (retry, times) => {
      try {
        service = await this.retryUntilSlsCreated(serviceName, options, !service)
      } catch (ex) {
        if (ex.code === 'AccessDenied' || ex.code === 'InvalidArgument' || this.isSlsNotExistException(ex)) {
          throw ex
        }
        debug('error when createService or updateService, serviceName is %s, options is %j, error is: \n%O', serviceName, options, ex)

        console.log(red(`\tretry ${times} times`))
        retry(ex)
      }
    })

    // make sure nas dir exist
    if (serviceName !== FUN_GENERATED_SERVICE &&
      !_.isEmpty(nasConfig) &&
      !_.isEmpty(nasConfig.MountPoints)) {
      await this.ensureNasDirExist({
        role, vpcConfig, nasConfig
      })
    }

    return service
  }

  async deploy (serviceName, serviceProp, hasFunctionAsyncConfig, hasCustomContainerConfig) {
    const internetAccess = 'InternetAccess' in serviceProp ? serviceProp.InternetAccess : null
    const description = serviceProp.Description

    const vpcConfig = serviceProp.Vpc
    const nasConfig = serviceProp.Nas
    const logConfig = serviceProp.Log || {}

    const roleArn = (serviceProp.Role || {}).Name
    const policies = (serviceProp.Role || {}).Policies

    const role = await this.generateServiceRole({
      hasFunctionAsyncConfig,
      hasCustomContainerConfig,
      serviceName,
      roleArn,
      policies,
      vpcConfig,
      nasConfig,
      logConfig
    })

    await this.makeService({
      logConfig,
      vpcConfig,
      nasConfig,
      serviceName,
      role,
      internetAccess,
      description
    })
    return serviceName
  }

  async getService (serviceName) {
    return await this.fcClient.getService(serviceName)
  }
}

module.exports = Service
