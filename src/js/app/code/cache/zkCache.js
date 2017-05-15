/**
* @Author: robin
* @Date:   2017-05-08 10:37
* @Email:  xin.lin@qunar.com
* @Last modified by:   robin
* @Last modified time: 2017-05-08 10:37
*/



var _ = require('lodash'),
    Cache = require('./cache'),
    zkClient = require('../../../common/zkClient'),
    utils = require('../../../common/utils'),
    NODE_STEP = {
        ROOT: 0,
        USER: 1,
        CONTAINER: 2,
        OBJECT: 3
    };

/**
 * 缓存所有仓库和包的索引信息
 * zookeeper中路径规则为 /npm_cache_share/{user}/{repository}/{moduleName}  节点信息里含有版本
 * @type {Object}
 */
function ZkCache(opts){
    //内部缓存
    this._cache = new Cache();
    //zookeeper客户端
    zkClient.init(opts.zookeeper);
    //用户
    this._user = getUser(opts.storageConfig);
    this._snapshotUser = getUser(opts.storageSnapshotConfig);
}

ZkCache.prototype = {
    /**
     * 缓存就绪后执行
     * @return {Promise}
     */
    ready: function(){
        var cache = this._cache,
            self = this;

        return new Promise(function(resolve, reject){
            //连接zookeeper
            zkClient.connect().then(function(){
                init(self._user, false);

                if(self._user != self._snapshotUser){
                    init(self._snapshotUser, true);
                }

                resolve();
            });
        });

        function init(user, isSnapshot) {
            zkClient.exist(user).then(function(isExist){
                if(isExist){
                    //监听用户节点
                    monitorNode.call(self, isSnapshot, user, cache, function(isSnapshot, path, cache){
                        //监听容器节点
                        monitorNode.call(self, isSnapshot, path, cache, null, NODE_STEP.CONTAINER);
                    }, NODE_STEP.USER);
                    return;
                }
                zkClient.mkdirp(user).then(function(){
                    //监听用户节点
                    monitorNode.call(self, isSnapshot, user, cache, function(isSnapshot, path, cache){
                        //监听容器节点
                        monitorNode.call(self, isSnapshot, path, cache, null, NODE_STEP.CONTAINER);
                    }, NODE_STEP.USER);
                });
            });
        }
    },
    /**
     * RELEASE和SNAPSHOT是一致的
     * @return {void}
     */
    same: function(){
        this._cache.same();
    },
    /**
     * 清空缓存
     * @return {void}
     */
    clear: function(){
        this._cache.clear();
    },
    /**
     * 增加仓库
     * @param {Boolean} isSnapshot 是否是snapshot
     * @param {String} name 仓库名称
     * @param {Object} stat 仓库状态
     */
    addRepository: function(isSnapshot, name, stat){
        var cache = this._cache,
            reps = cache.listRepository(isSnapshot),
            path = generatePath.call(this, isSnapshot, name);
        //判断缓存中是否存在
        if(!reps[name]){
            zkClient.exist(path).then(function(isExist){
                if(isExist){
                    cache.addRepository(isSnapshot, name, stat);
                    doAdd();
                    return;
                }
                zkClient.mkdirp(path).then(function(){
                    doAdd();
                });
            });
        }else{
            doAdd();
        }

        function doAdd() {
            //设置容器节点信息
            if(stat){
                zkClient.setData(path, JSON.stringify(stat));
            }
        }
    },
    /**
     * 删除仓库
     * @param  {Boolean} isSnapshot 是否是snapshot
     * @param  {String} name 仓库名称
     * @return {boolean}     是否删除成功
     */
    delRepository: function(isSnapshot, name) {
        var path = generatePath.call(this, isSnapshot, name);
        zkClient.remove(path);
    },
    /**
     * 追加包到仓库
     * @param {Boolean} isSnapshot 是否是snapshot
     * @param {String} repository 仓库名称
     * @param {String} name       包名称，形如“five@0.0.1”
     */
    addPackage: function(isSnapshot, repository, name){
        var cache = this._cache,
            moduleName = utils.splitModuleName(name),
            path = generatePath.call(this, isSnapshot, repository, moduleName),
            modules = cache.listModules(isSnapshot, repository);
        if(!modules[moduleName]){
            zkClient.exist(path).then(function(isExist){
                if(isExist){
                    zkClient.getData(path).then(function(data){
                        if(!RegExp('(?=[^,])' + name + '(?=(,|$)),?').test(data)){
                            zkClient.setData(path, data ? [data, name].join(',') : name);
                        }else{
                            cache.addPackage(isSnapshot, repository, name);
                        }
                    });
                    return;
                }
                zkClient.mkdirp(path).then(function(){
                    zkClient.setData(path, name);
                });
            });
        }else{
            if(!RegExp('(?=[^,])' + name + '(?=(,|$)),?').test(modules[moduleName])){
                zkClient.setData(path, (modules[moduleName].concat(name)).join(','));
            }
        }
    },
    /**
     * 从仓库中删除包
     * @param  {Boolean} isSnapshot 是否是snapshot
     * @param  {String} repository 仓库名称
     * @param  {String} name       包名称
     * @return {boolean}           是否删除成功
     */
    delPackage: function(isSnapshot, repository, name) {
        var moduleName = utils.splitModuleName(name),
            path = generatePath.call(this, isSnapshot, repository, moduleName),
            modules = this._cache.listModules(isSnapshot, repository);
        if(!modules[moduleName]){
            zkClient.exist(path).then(function(isExist){
                if(isExist){
                    zkClient.getData(path).then(function(data){
                        zkClient.setData(path, replaceName(data, name));
                    });
                }
            });
        }else{
            zkClient.setData(path, replaceName(modules[moduleName].join(','), name));
        }
    },
    /**
     * 返回缓存全部内容
     * @param  {Boolean} isSnapshot 是否是snapshot
     * @return {Object} 缓存对象
     */
    listAll: function(isSnapshot) {
        return this._cache.listAll.apply(this._cache, arguments);
    },
    /**
     * 返回仓库列表
     * @param  {Boolean} isSnapshot 是否是snapshot
     * @return {Array} 数组每项包含name，stat
     */
    listRepository: function(isSnapshot){
        return this._cache.listRepository.apply(this._cache, arguments);
    },
    /**
     * 返回模块列表
     * @param  {Boolean} isSnapshot 是否是snapshot
     * @param  {string} repository 仓库名称
     * @return {Array}            数组每项为模块名（不含版本号以及环境）
     */
    listModules: function(isSnapshot, repository){
        return this._cache.listModules.apply(this._cache, arguments);
    },
    /**
     * 返回模块下的包列表
     * @param  {Boolean} isSnapshot 是否是snapshot
     * @param  {string} repository 仓库名称
     * @param  {string} name       模块名
     * @return {Array}            数组每项为包名称（含版本号以及环境）
     */
    listPackages: function(isSnapshot, repository, name){
        return this._cache.listPackages.apply(this._cache, arguments);
    },
    /**
     * 比较需要的模块与缓存内容，返回缓存中存在的包名称
     * @param  {string} repository 仓库名称
     * @param  {Array} list       所需的模块列表（包含版本号，不含环境）
     * @param  {string} platform   环境信息
     * @return {HashMap}            缓存存在的模块列表（包含版本号和环境）
     */
    diffPackages: function(repository, list, platform){
        return this._cache.diffPackages.apply(this._cache, arguments);
    },
    setStorage: function(st){
        this._cache.setStorage(st);
    }
};
/*@Factory("zkCache")*/
module.exports = ZkCache;
/**
 * 获取用户信息
 * @param  {String} config 配置信息
 * @return {String}
 */
function getUser(config){
    return config.split('|')[1].split(':')[0];
}
/**
* 生成节点路径
* @param  {Boolean} isSnapshot 是否是SNAPSHOT版本
* @param  {String}  repository  容器名称
* @param  {String}  moduleName 模块名称
* @return {String}
*/
function generatePath(isSnapshot, repository, moduleName){
    var user = isSnapshot ? this._snapshotUser : this._user;
    return moduleName ? [user, repository, moduleName].join('/') : [user, repository].join('/');
}
/**
 * 监听节点变更
 * @param  {Boolean} isSnapshot 是否是SNAPSHOT版本
 * @param  {String}  path       节点路径
 * @param  {Cache}  cache       本地内存缓存
 * @param  {Function} callback  获取数据回调
 * @param  {NODE_STEP} nodeStep 节点层级
 * @return {void}
 */
function monitorNode(isSnapshot, path, cache, callback, nodeStep) {
    var childrens, p, repository;
    //获取初始节点数
    zkClient.getChildren(path).then(function(data){
        //获取容器名称
        if(nodeStep == NODE_STEP.CONTAINER){
            repository = path.split('/').pop();
        }
        childrens =  data;
        console.debug('获取' + path + '节点下所有子节点:' + data);
        //监听当前节点下的子节点
        _.forEach(childrens, function(v){
            p = [path, v].join('/');
            //添加容器节点
            if(nodeStep == NODE_STEP.USER){
                console.debug('新增' + v + '容器');
                cache.addRepository(isSnapshot, v);
            }
            callback && callback(isSnapshot, p, cache);
            //监听数据
            monitorData(isSnapshot, p, cache, repository || v, null, nodeStep == NODE_STEP.CONTAINER);
        });
    }).then(function(){
        console.debug('新增' + path + '节点监听');
        //注册用户节点事件
        zkClient.register(zkClient.Event.NODE_CHILDREN_CHANGED, path, function(data){
            console.debug('触发' + path + '节点监听事件');
            var addChanges = _.difference(data, childrens),
                rmChanges = _.difference(childrens, data);
            if(addChanges.length == 0 && rmChanges.length == 0){
                console.debug(path + '没有变化');
                return;
            }
            //新增节点处理
            _.forEach(addChanges, function(v){
                p = [path, v].join('/');
                //添加容器节点
                if(nodeStep == NODE_STEP.USER){
                    console.debug('新增' + v + '容器');
                    cache.addRepository(isSnapshot, v);
                    callback && callback(isSnapshot, p, cache);
                }
                //监听数据
                monitorData(isSnapshot, p, cache, repository || v, null, nodeStep == NODE_STEP.CONTAINER);
            });
            //删除节点处理
            _.forEach(rmChanges, function(v){
                p = [path, v].join('/');
                //删除容器节点
                if(nodeStep == NODE_STEP.USER){
                    console.debug('删除' + v + '容器');
                    //删除子节点监听
                    _.forEach(cache.listModules(), function(c){
                        console.log('删除监听' + [p, c].join('/'));
                        zkClient.unregister(zkClient.Event.NODE_DATA_CHANGED, [p, c].join('/'));
                        zkClient.unregister(zkClient.Event.NODE_CHILDREN_CHANGED, [p, c].join('/'));
                    });
                    cache.delRepository(isSnapshot, v);
                }
                zkClient.unregister(zkClient.Event.NODE_DATA_CHANGED, p);
            });
            childrens = data;
        });
    });
}
/**
 * 监听节点数据变更
 * @param  {Boolean} isSnapshot 是否是SNAPSHOT版本
 * @param  {String}  path       节点路径
 * @param  {Cache}  cache       本地内存缓存
 * @param  {String}  repository 容器名
 * @param  {Function} callback  获取数据回调
 * @param  {Boolean} isModule   是否是模块
 * @return {void}
 */
function monitorData(isSnapshot, path, cache, repository, callback, isModule) {
    var oriData;
    //记录原始节点数据
    zkClient.getData(path).then(function(data){
        if(isModule){
            //叶子节点的数据是以逗号分割的版本，叶子节点=模块
            console.debug('获取' + path + '节点信息:' + data);
            if(data){
                data = data.split(',');
                //新增模块版本
                _.forEach(data, function(v){
                    console.debug('新增' + repository + '容器中对象:' + v);
                    cache.addPackage(isSnapshot, repository, v);
                });
            }
        }else{
            cache.addRepository(isSnapshot, repository, dataDeal(data));
        }
        oriData = data;
        callback && callback(isSnapshot, repository, data);
    }).then(function(){
        console.debug('新增' + path + '节点数据监听');
        //监听节点数据变更
        zkClient.register(zkClient.Event.NODE_DATA_CHANGED, path, function(data) {
            if(isModule){
                data = data.split(',');
                //看数据是否发生变更
                //叶子节点的数据是以逗分割的版本，叶子节点=模块
                var addVersions = _.difference(data, oriData),
                    rmVersions = _.difference(oriData, data);
                if(addVersions.length == 0 && rmVersions.length == 0){
                    return;
                }
                //新增模块版本
                _.forEach(addVersions, function(v){
                    if(!v) return;
                    console.debug('新增' + path + '节点信息:' + v);
                    cache.addPackage(isSnapshot, repository, v);
                });
                //删除模块版本
                _.forEach(rmVersions, function(v){
                    if(!v) return;
                    console.debug('删除' + path + '节点信息:' + v);
                    cache.delPackage(isSnapshot, repository, v);
                });
            }else{
                //更新节点信息
                cache.addRepository(isSnapshot, repository, dataDeal(data));
            }
            oriData = data;
        });
    });
}
function replaceName(name, match) {
    name = name.replace(RegExp('(?=[^,]' + match + '(?=(,|$)),?'), '');
    if(_.endsWith(name, ',')){
        name = name.substr(0, name.length -1);
    }
    return name;
}
function dataDeal(data){
    if(RegExp('^{[^}]+}$').test(data)){
        return JSON.parse(data);
    }
    return data;
}
