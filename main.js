var fs = require('fs'),					//读写文件模块
	Promise = require('bluebird'),		//Promise模块
	_ = require('underscore'),			//underscore模块

	threads = 1,						//默认线程数
	task,								//当前任务对象
	taskName = '',						//当前任务名（用于txt输出）
	taskUrl = '',						//当前任务url
	hostUrl = '',						//当前主机地址
	configTaskQueue = [],				//配置文件入口，任务队列
	workQueue = [],						//任务的对应主工作队列
	hasDone = [],						//去重，记录所有已爬取过的url
	workerArray = [];					//worker数组


//读取config.txt配置文件
function getConfig() {
	return new Promise(function(resolve, reject){
		fs.readFile('./config/config.txt', 'utf-8', function(err, data){
			if (err){
				reject(err);
				return ;
			}
			//解析json，拿出线程数与入口url
			try{
				var config = JSON.parse(data);
				threads = parseInt(config['threads']);
				configTaskQueue = config['tasks'];

				//根据线程数，初始化worker
				for (var i = 0; i < threads; i++) {
					var worker = new Worker();
					worker.num = i+1;
					workerArray.push(worker);
				}

				resolve();
			}
			catch (err){
				console.error(err);
				reject(err);
			}
		});	
	});	
}

//根据configTaskQueue中读入的任务，取出第一个，并初始化全局变量
function getStart(){
	return new Promise(function(resolve, reject){
		if (configTaskQueue.length > 0){
			var getNewTask = configTaskQueue.shift();
			//全局记录当前任务
			taskName = getNewTask['name'];
			taskUrl = getNewTask['url'];

			//取出根域名
			hostUrl = taskUrl.replace(/http(s*):\/\//, '');
			hostUrl = hostUrl.split('/')[0];
			workQueue.push(taskUrl);

			console.log('================================');
			console.log('Start grabbing task: ' + taskName);
			console.log('================================');

			resolve();
		}
		else{
			console.error('Get tasks in "config.txt" err!');
			reject();
		}
	});
}

//清空原有urls.txt，videoInfo.txt
function cleanFiles(){
	return new Promise(function(resolve, reject){
		var write_cnt = 0;
		function finish_writing(){
			if (write_cnt == 2){
				resolve();
			}
		}
		fs.writeFile('website/'+hostUrl+'/output_data/'+taskName+'_urls.txt', '', {"encoding":"utf-8"}, function(err){
			if (err){
				reject(err);
				return ;
			}
			write_cnt ++;
			finish_writing();
		});
		fs.writeFile('website/'+hostUrl+'/output_data/'+taskName+'_videoInfo.txt', '', {"encoding":"utf-8"}, function(err){
			if (err){
				reject(err);
				return ;
			}
			write_cnt++;
			finish_writing();
		});
	});
}

//主Worker类
function Worker(){
	this.working = false;		//工作状态
	this.num = 0;				//线程号
	this.url = '';				//当前工作中url
	this.startTime;				//记录任务开始时间
}

//Worker加载url对应路由，找出处理文件
Worker.prototype.queryRouter = function(url){
	var routerFile = require('./website/' + hostUrl + '/_.js');
	var router = routerFile()['route'];

	//根据url查询路由表，找出对应解析文件，返回解析接口
	var workerFileName = '';
	for (var i = 0; i < router.length; i++) {
		var cur = router[i];
		var reg = cur[0];

		//匹配路由正则
		if (url.match(reg)){
			workerFileName = cur[1];
			break;
		}
	}

	return new Promise(function(resolve, reject){
		//找到解析文件
		if (workerFileName != ''){
			var worker = require('./website/' + hostUrl + '/' + workerFileName);
			resolve({
				url: url,
				worker: worker
			});
		}
		else{
			reject('NO MATCH PATH');
		}
	});

}

//Worker获得数据后写入到文件
Worker.prototype.writeData = function(data){
	var urls_to_Write = '';

	for (var i = 0; i < data.grabUrls.length; i++) {
		if (_.indexOf(hasDone, data.grabUrls[i]) == -1){
			//若url未被爬取过，推入去重数组
			hasDone.push(data.grabUrls[i]);	
			//推入任务队列
			workQueue.push(data.grabUrls[i]);
			urls_to_Write += data.grabUrls[i] + '\n';
		}
	}

	return new Promise(function(resolve, reject){
		//记录写文件状态
		var need_cnt = 0,
			finish_cnt = 0;

		//确保两个文件都写完才调用resolve
		function finish_writing(){
			if (need_cnt == finish_cnt){
				resolve();
			}
		}
		//视频urls数组
		if (urls_to_Write != ''){
			need_cnt ++;
			fs.appendFile('website/'+hostUrl+'/output_data/'+taskName+'_urls.txt', urls_to_Write, 'utf-8', function(err){
				if (err){
					reject(err);
					return ;
				}
				finish_cnt ++;
				finish_writing();
			});
		}
		//单个视频具体信息
		if (!_.isEmpty(data.videoInfo)){
			need_cnt ++;
			fs.appendFile('website/'+hostUrl+'/output_data/'+taskName+'_videoInfo.txt', JSON.stringify(data.videoInfo) + '\n\n', 'utf-8', function(err){
				if (err){
					reject(err);
					return ;
				}
				finish_cnt++;
				finish_writing();
			})
		}

	});
}

//Worker启动工作函数
Worker.prototype.startup = function(){
	var that = this;

	var date = new Date();
	that.startTime = date.getTime();

	//将工作状态置为true
	that.working = true;
	console.log('Thread ' + that.num + ' start -> ' + that.url);

	//启动工作
	that
	.queryRouter(that.url)
	.then(function(arg){
		//调用解析接口
		return arg.worker(arg.url);
	})
	.then(function(data){
		//写获得数据
		return that.writeData(data);
	})
	.then(function(){
		//工作完成，将worker状态置为false
		that.working = false;
		console.log('Thread ' + that.num + ' finish!');
	})
	.catch(function(err){
		//任务除错，抛弃任务
		that.working = false;
		console.error('Thread ' + that.num + ' ' +err);
	});
}


//task工作类。同时刻只能有一个活动对象
function Task(){
	var interval_handle1,
		interval_handle2;
	//初始启动 + 配置全局变量 + 清空原有数据
	this.init = function(){
		getStart()
		.then(function(){
			return cleanFiles();
		})
		.then(function(){
			//每相隔(200)毫秒，定时检查worker状态。空闲则分配新任务
			interval_handle1 = setInterval(function(){
				//有未处理任务
				for (var i = 0; i < threads; i++) {
					if (workQueue.length > 0){
						//worker空闲，派发新任务
						if (!workerArray[i].working){
							var taskUrl = workQueue.shift();
							workerArray[i].url = taskUrl;
							workerArray[i].startup();
						}
					}
					else{
						//暂时任务队列为空
						break ;
					}
				}
			}, 200);

			//每相隔(5)秒，检查worker是否已超时。超时时间(10)秒
			interval_handle2 = setInterval(function(){
				var date = new Date();
				var time = date.getTime();
				for (var i = 0; i < threads; i++) {
					if (time - workerArray[i].startTime > 10*1000){
						var num = workerArray[i].num;
						var url = workerArray[i].url;
						console.log('Thread ' + num + ' timeout!!!Start a new thread!');
						workerArray[i] = new Worker();
						workerArray[i].num = num;

						workQueue.push(url);
					}
				}
			}, 5*1000)	;
		})
	};
	this.done = function(){
		clearInterval(interval_handle1);
		clearInterval(interval_handle2);
	};
}

//主入口函数
function main(){
	//初始调用getConfig，然后启动任务函数
	getConfig()
	.then(function(){
		task = new Task();
		task.init();
	})
	.catch(function(err){
		console.error(err);
		task.done();
		task = null;
	});

	//每隔(10)秒，定时检查当前task是否已完成
	var interval_handle = setInterval(function(){
		if (workQueue.length == 0){
			//有worker处于工作状态，未完成
			var notFinish = _.some(workerArray, function(worker){
				return worker.working;
			});
			
			//所有worker空闲，证明原任务已完成
			if (!notFinish){
				//清空原任务
				task.done();
				task = null;
				console.log(' ');
				console.log('current task done! Getting new task...');
				console.log(' ');
				//若有，则取下一个任务
				if (configTaskQueue.length > 0){
					task = new Task();
					task.init();			
				}
				//config.txt中所有任务对已经完成，程序出口，结束程序！
				else{
					console.log('All tasks in "config.txt" has been dong!!!');
					clearInterval(interval_handle);
					//强制退出进程，防止有时卡死无法退出的情况
					process.exit(0);
				}
			}
		}
	}, 10*1000);
}


//入口
main();