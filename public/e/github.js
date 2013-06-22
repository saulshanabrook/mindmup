/*global $, _, jQuery, document, MM, window, sessionStorage */
MM.GithubAPI = function () {
	'use strict';
	var self = this,
		SESSION_AUTH_CACHE_KEY = 'github_auth_token',
		authToken = function () {
			return window.sessionStorage && window.sessionStorage[SESSION_AUTH_CACHE_KEY];
		},
		setAuthToken = function (tokenString) {
			if (!window.sessionStorage) { // fake it
				window.sessionStorage = {};
			}
			window.sessionStorage[SESSION_AUTH_CACHE_KEY] = tokenString;
		},
		sendRequest = function (url, resultParser, requestType, requestData) {
			var baseUrl = 'https://api.github.com',
				result = jQuery.Deferred(),
				request = {
					url: baseUrl + url,
					type: requestType || 'GET',
					headers: {'Authorization': 'bearer ' + authToken()}
				};
			if (requestData) {
				request.data = JSON.stringify(requestData);
				request.processData = false;
			}
			if (!authToken()) {
				return result.reject('not-authenticated').promise();
			}
			jQuery.ajax(request).then(
				function (githubData) {
					if (resultParser) {
						if (_.isArray(githubData)) {
							result.resolve(_.map(githubData, resultParser));
						} else {
							result.resolve(resultParser(githubData));
						}
					} else {
						result.resolve(githubData);
					}
				},
				result.reject,
				result.notify
			);
			return result.promise();
		},
		guessMimeType = function (fileName) {
			if (/\.mm$/.test(fileName)) {
				return 'application/x-freemind';
			}
			if (/\.mup$/.test(fileName)) {
				return 'application/json';
			}
		},
		componentPathToUrl = function (githubComponentPath) {
			var url = '/repos/' + githubComponentPath.repo + '/contents';
			if (!(/^\//).test(githubComponentPath.path)) {
				url = url + '/';
			}
			if (githubComponentPath.path) {
				url = url + githubComponentPath.path;
			}
			return url;
		};
	self.loadFile = function (githubComponentPath) {
		var url = componentPathToUrl(githubComponentPath),
			deferred = jQuery.Deferred();
		if (githubComponentPath.branch) {
			url = url + "?ref=" + githubComponentPath.branch;
		}
		sendRequest(url).then(
			function (githubData) {
				var contents;
				if (githubData.encoding === 'base64') {
					contents = window.Base64.decode(githubData.content);
					deferred.resolve(contents, guessMimeType(githubData.name));
				} else {
					deferred.reject('format-error', 'Unknown encoding ' + githubData.encoding);
				}
			},
			deferred.reject,
			deferred.notify
		);
		return deferred.promise();
	};
	self.saveFile = function (contentToSave, githubComponentPath, commitMessage) {
		var url = componentPathToUrl(githubComponentPath),
			metaUrl = url,
			deferred = jQuery.Deferred(),
			saveWithSha = function (sha) {
				deferred.notify('sending file to Github');
				sendRequest(url, false, 'PUT', {
					content: window.Base64.encode(contentToSave),
					message: commitMessage,
					sha: sha,
					branch: githubComponentPath.branch,
				}).then(
					deferred.resolve,
					deferred.reject,
					deferred.notify
				);
			};
		if (githubComponentPath.branch) {
			metaUrl = metaUrl + "?ref=" + githubComponentPath.branch;
		}
		deferred.notify('fetching meta-data');
		sendRequest(metaUrl).then(
			function (githubFileMeta) {
				saveWithSha(githubFileMeta && githubFileMeta.sha);
			},
			function (result) {
				saveWithSha('');
			},
			deferred.notify
		);
		return deferred.promise();
	};
	self.login = function (withDialog) {
		var deferred = jQuery.Deferred(),
			popupFrame;
		if (authToken()) {
			return deferred.resolve();
		}
		if (!withDialog) {
			return deferred.reject('not-authenticated');
		}
		popupFrame = window.open('/github/login', '_blank', 'height=400,width=700,location=no,menubar=no,resizable=yes,status=no,toolbar=no');
		popupFrame.addEventListener('message', function (message) {
			if (message && message.data && message.data.github_token) {
				setAuthToken(message.data.github_token);
				deferred.resolve();
			} else if (message && message.data && message.data.github_error) {
				deferred.reject('failed-authentication', message.data.github_error);
			}
		});
		return deferred.promise();
	};
	self.getRepositories = function (owner, ownerType) {
		var repoParser = function (githubData) {
				return {
					type: 'repo',
					name: githubData.full_name,
					defaultBranch: githubData.default_branch
				};
			},
			url;
		if (ownerType === 'org') {
			url = '/orgs/' + owner + '/repos';
		} else if (owner) {
			url = '/users/' + owner + '/repos';
		} else {
			url = '/user/repos';
		}
		return sendRequest(url, repoParser);
	};
	self.getBranches = function (repository) {
		var branchParser = function (githubData) {
			return githubData.name;
		};
		return sendRequest('/repos/' + repository + '/branches', branchParser);
	};
	self.getFiles = function (repository, branch, path) {
		path = path || '';
		var filesAndDirsParser = function (githubData) {
				return _.pick(githubData, ['type', 'name', 'path']);
			},
			url = '/repos/' + repository + '/contents/' + path;
		if (branch) {
			url = url + "?ref=" + branch;
		}
		return sendRequest(url, filesAndDirsParser);
	};
	self.getOrgs = function () {
		var orgParser = function (githubData) {
			return { name: githubData.login, pictureUrl: githubData.avatar_url, type: 'org' };
		};
		return sendRequest('/user/orgs', orgParser);
	};
	self.getUser = function () {
		var userParser = function (githubData) {
			return { name: githubData.login, pictureUrl: githubData.avatar_url, type: 'user' };
		};
		return sendRequest('/user', userParser);
	};
};
MM.GithubFileSystem = function (api, commitPrompter, fileNamePrompter) {
	'use strict';
	var self = this,
		toGithubComponentPath = function (mindMupMapId) {
			if (!mindMupMapId || mindMupMapId.length < 3) {
				return {};
			}
			var components = mindMupMapId.slice(2).split(':');
			return {
				repo: components && components[0],
				branch: components && components[1],
				path: components && components[2]
			};
		},
		properties = {editable: true, sharable: true};
	self.loadMap = function (mapId, showAuthenticationDialogs) {
		var deferred = jQuery.Deferred(),
			readySucceeded = function () {
				api.loadFile(toGithubComponentPath(mapId)).then(
					function (content, mimeType) {
						deferred.resolve(content, mapId, mimeType, properties);
					},
					deferred.reject,
					deferred.notify
				);
			};
		api.login(showAuthenticationDialogs).then(readySucceeded, deferred.reject, deferred.notify);
		return deferred.promise();
	};
	self.saveMap = function (contentToSave, mapId, fileName, showAuthenticationDialogs) {
		var deferred = jQuery.Deferred(),
			saveWhenAuthorised = function () {
				var path = toGithubComponentPath(mapId);
				if (!path.path) {
					fileNamePrompter.promptForFileName('Save to Github', true, fileName).then(
						function (newMapId) {
							self.saveMap(contentToSave, newMapId, fileName, showAuthenticationDialogs)
								.then(deferred.resolve, deferred.reject, deferred.notify);
						},
						deferred.reject,
						deferred.notify
					);
				} else {
					commitPrompter.promptForCommit().then(
						function (commitMessage) {
							api.saveFile(contentToSave, path, commitMessage).then(
								function () {
									deferred.resolve(mapId, properties);
								},
								deferred.reject,
								deferred.notify
							);
						},
						deferred.reject,
						deferred.notify
					);
				}
			};
		api.login(showAuthenticationDialogs).then(
			saveWhenAuthorised,
			deferred.reject,
			deferred.notify
		);
		return deferred.promise();
	};
	self.prefix = 'h';
	self.recognises = function (mapId) {
		return mapId && mapId[0] === self.prefix;
	};
	self.description = "GitHub";
};

$.fn.githubOpenWidget = function (api, defaultAction) {
	'use strict';
	var modal = this,
		defaultTitle = modal.find('[data-mm-role=dialog-title]').text(),
		title = defaultTitle,
		allowNew = false,
		deferredCaller,
		template = this.find('[data-mm-role=template]'),
		fileList = template.parent(),
		statusDiv = this.find('[data-mm-role=status]'),
		newFile = this.find('[data-mm-role=new-file]'),
		currentLoc = this.find('[data-mm-role=current-location]'),
		ownerField = this.find('[data-mm-role=owner]'),
		showAlert = function (message, type, detail, callback) {
			type = type || 'error';
			if (callback) {
				detail = "<a>" + detail + "</a>";
			}
			statusDiv.html('<div class="alert fade-in alert-' + type + '">' +
					'<button type="button" class="close" data-dismiss="alert">&#215;</button>' +
					'<strong>' + message + '</strong>' + detail + '</div>');
			if (callback) {
				statusDiv.find('a').click(callback);
			}
		},
		dynamicDropDown = function (self, buttonRole, listRole, deferredQuery) {
			var deferred = jQuery.Deferred(),
				ownerSearch = self.find('[data-mm-role=' + buttonRole + ']'),
				list = self.find('[data-mm-role=' + listRole + ']'),
				startSpin = function () {
					ownerSearch.find('.icon-spinner').show();
				},
				stopSpin = function () {
					ownerSearch.find('.icon-spinner').hide();
				},
				appendResults = function (results) {
					_.each(results, function (element) {
						var link = $('<a>').text(element);
						link.click(function () {
							deferred.resolve(element);
						});
						$("<li>").append(link).appendTo(list);
					});
				};
			ownerSearch.click(function () {
				list.empty();
				startSpin();
				deferredQuery().done(appendResults).fail(deferred.reject).always(stopSpin);
			});
			return deferred.promise();
		},
		fileRetrieval = function (showPopup, query) {
			query = query || {};
			var	filesLoaded = function (result) {
					statusDiv.empty();
					if (query.repo) {
						currentLoc.text(query.repo + (query.branch ? '(' + query.branch + ')' : '') + "/" +  (query.path || ''));
					} else {
						currentLoc.text('Please select a repository');
					}
					var sorted = _.sortBy(result, function (item) {
							return item && item.type + ':' + item.name;
						}),
						added;
					if (query.back) {
						added = template.filter('[data-mm-type=dir]').clone().appendTo(fileList);
						added.find('[data-mm-role=dir-link]').click(function () {
							fileRetrieval(false, query.back);
						});
						added.find('[data-mm-role=dir-name]').text('..');
					}
					if (query && query.repo && allowNew) {
						newFile.show();
						newFile.data('mm-current-path', 'h1' + query.repo + ':' + query.branch + ':');
					} else {
						newFile.hide();
					}
					_.each(sorted, function (item) {

						if (item) {
							if (item.type === 'repo') {
								added = template.filter('[data-mm-type=repo]').clone().appendTo(fileList);
								added.find('[data-mm-role=repo-link]').click(function () {
									fileRetrieval(false, {repo: item.name, branch: item.defaultBranch, back: query});
								});
								added.find('[data-mm-role=repo-name]').text(item.name);
								added.find('[data-mm-role=repo-default-branch]').text(item.defaultBranch);
								dynamicDropDown(added, 'branch-search', 'branch-list', function () {
									return api.getBranches(item.name);
								}).then(
									function (selectedBranch) {
										fileRetrieval(false, {repo: item.name, branch: selectedBranch, back: query});
									},
									function () {
										showAlert('Could not load user information from Github, please try later');
									}
								);
							} else if (item.type === 'dir') {
								added = template.filter('[data-mm-type=dir]').clone().appendTo(fileList);
								added.find('[data-mm-role=dir-link]').click(function () {
									fileRetrieval(false, {repo: query.repo, branch: query.branch, path: item.path, back: query});
								});
								added.find('[data-mm-role=dir-name]').text(item.name);
							} else if (item.type === 'file') {
								added = template.filter('[data-mm-type=file]').clone().appendTo(fileList);
								added.find('[data-mm-role=file-link]').click(function () {
									var action = (deferredCaller && deferredCaller.resolve) || defaultAction;
									action('h1' + query.repo + ':' + query.branch + ':' + item.path);
									modal.modal('hide');
								});
								added.find('[data-mm-role=file-name]').text(item.name);
							}

						}
					});
				},
				showError = function (reason) {
					if (reason === 'failed-authentication') {
						showAlert('Authentication failed, we were not able to access your Github repositories');
					} else if (reason === 'not-authenticated') {
						showAlert(
							'<h4>Authorisation required<h4>',
							'block',
							'Click here to authorise with Github',
							function () {
								fileRetrieval(true, query);
							}
						);
					} else {
						showAlert('There was a network error, please try again later');
					}
				};
			fileList.empty();
			statusDiv.html('<i class="icon-spinner icon-spin"/> Retrieving files...');
			api.login(showPopup).then(function () {
				if (query.owner) {
					api.getRepositories(query.owner, query.ownerType).then(filesLoaded, showError);
				} else if (query.repo) {
					api.getFiles(query.repo, query.branch, query.path).then(filesLoaded, showError);
				} else {
					api.getRepositories().then(filesLoaded, showError);
				}
			}, showError);
		},
		changeOwner = function () {
			var link = $(this);
			ownerField.val(link.data('mm-owner'));
			if (link.data('mm-owner-type') === 'org') {
				fileRetrieval(false, {owner: link.data('mm-owner'), ownerType: 'org' });
			} else {
				fileRetrieval();
			}
		},
		userMetaDataLoaded = false,
		loadUserMetaData = function () {
			var ownerSearch = modal.find('[data-mm-role=owner-search]'),
				list = modal.find('[data-mm-role=owner-list]'),
				startSpin = function () {
					ownerSearch.find('.icon-spinner').show();
				},
				stopSpin = function () {
					ownerSearch.find('.icon-spinner').hide();
				},
				appendUser = function (user) {
					var userLink = $('<a>').data('mm-owner', user.name).data('mm-owner-type', user.type).text(user.name);
					userLink.click(changeOwner);
					$("<li>").append(userLink).appendTo(list);
				},
				appendOrgs = function (orgs) {
					_.each(orgs, appendUser);
				},
				loaded = function () {
					userMetaDataLoaded = true;
					statusDiv.empty();
					stopSpin();
				},
				loadError = function () {
					stopSpin();
					showAlert('Could not load user information from Github, please try later');
				};
			if (userMetaDataLoaded) {
				return;
			}
			list.empty();
			startSpin();
			api.getUser().then(
				function (userInfo) {
					appendUser(userInfo);
					api.getOrgs().then(
						function (orgs) {
							appendOrgs(orgs);
							loaded();
						},
						loadError
					);
				},
				loadError
			);
		},
		createNewFile = function () {
			var input = newFile.find('input');
			if (input.val()) {
				deferredCaller.resolve(newFile.data('mm-current-path') + '/' + input.val());
				modal.modal('hide');
			}
			return false;
		};
	modal.on('show', function () {
		modal.find('.icon-spinner').hide();
		modal.find('[data-mm-role=dialog-title]').text(title);
		fileRetrieval();
	});
	newFile.find('input').add(newFile.find('button')).click(createNewFile).keydown('return', createNewFile);
	modal.find('[data-mm-role=owner-search]').click(loadUserMetaData);
	ownerField.change(function () {
		fileRetrieval(false, {owner: this.value, ownerType: 'user'});
	}).keydown('return', function (e) {
		fileRetrieval(false, {owner: this.value, ownerType: 'user'});
		e.stopPropagation();
		return false;
	});
	modal.on('hide', function () {
		if (deferredCaller) {
			deferredCaller.reject('user-cancel');
		}
		deferredCaller = undefined;
		allowNew = false;
		title = defaultTitle;
		newFile.find('input').val('');
		ownerField.val('');
	});
	modal.promptForFileName = function (dialogTitle, shouldAllowNewFile, defaultNewFileName) {
		title = dialogTitle;
		allowNew = shouldAllowNewFile;
		deferredCaller = jQuery.Deferred();
		modal.modal('show');
		newFile.find('input').val(defaultNewFileName);
		return deferredCaller.promise();
	};
	return modal;
};
$.fn.githubCommitWidget = function () {
	'use strict';
	var self = this,
		deferredCommitCall,
		input = self.find('input'),
		controlGroup = self.find('.control-group'),
		commit = self.find('[data-mm-role=commit]');
	self.on('show', function () {
		controlGroup.removeClass('error');
		input.val('');
	});
	self.on('shown', function () {
		input.focus();
	});
	self.on('hidden', function () {
		if (deferredCommitCall) {
			deferredCommitCall.reject('user-cancel');
			deferredCommitCall = undefined;
		}
	});
	self.find('form').submit(function () {
		commit.click();
		return false;
	});
	commit.click(function () {
		if (!input.val()) {
			controlGroup.addClass('error');
			return false;
		}
		if (deferredCommitCall) {
			deferredCommitCall.resolve(input.val());
			deferredCommitCall = undefined;
		}
	});
	self.promptForCommit = function () {
		deferredCommitCall = jQuery.Deferred();
		self.modal('show');
		return deferredCommitCall.promise();
	};
	return self;
};
MM.Extensions.GitHub = function () {
	'use strict';
	var api = new MM.GithubAPI(),
		mapController = MM.Extensions.components.mapController,
		loadUI = function (html) {
			var dom = $(html),
				modalOpen = dom.find('#modalGithubOpen').detach().appendTo('body').githubOpenWidget(api, mapController.loadMap.bind(mapController)),
				modalCommit = dom.find('#modalGithubCommit').detach().appendTo('body').githubCommitWidget(),
				fileSystem = new MM.GithubFileSystem(api, modalCommit, modalOpen);
			$('[data-mm-role=save] ul').append(dom.find('[data-mm-role=save-link]'));
			$('[data-mm-role=open-sources]').prepend(dom.find('[data-mm-role=open-link]'));
			mapController.addMapSource(new MM.RetriableMapSourceDecorator(new MM.FileSystemMapSource(fileSystem)));
			mapController.validMapSourcePrefixesForSaving += fileSystem.prefix;
		};
	$.get('/' + MM.Extensions.mmConfig.cachePreventionKey + '/e/github.html', loadUI);
	$('<link rel="stylesheet" href="/' + MM.Extensions.mmConfig.cachePreventionKey + '/e/github.css" />').appendTo($('body'));

};
MM.Extensions.GitHub();
