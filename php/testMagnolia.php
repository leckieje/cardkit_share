<?php
header("Access-Control-Allow-Origin: *");
header('Access-Control-Allow-Headers: Content-Type');

//class OnlineImages {

//	public static function create() {

		$files = $_FILES;
		$post  = $_POST;
		$file_paths =  array();

		//var_dump($files);
		//var_dump($post);

		chdir('tmp/');
		$file = fopen($_FILES['files']['name'][0], 'w');
		$contents = file_get_contents($_FILES['files']['tmp_name'][0]);
		fwrite($file, $contents);

		//var_dump($_FILES['files']['tmp_name'][0]);
		echo '{"gams_id":"BN-AB501","original_names":["cable-cutting-sketch_OR.jpg"],"urls":["http:\/\/online.s.dev.wsj.com\/public\/resources\/images\/BN-AB501_cablec_OR_20150320173324.jpg"]}';
		exit();

		$envs = array('QA', 'production');

		if(isset($post['env']) && in_array($post['env'], $envs)) {
			$_ENV['ENV'] = $post['env'];
		}

		$uploaddir = get_include_path() . '/tmp/';

		// check to see if files were uploaded
		if(!is_uploaded_file($files['files']['tmp_name'][0])) json_response(1, 'no files uploaded');

		// check is $files is array
		if(!is_array($files['files']['name'])) json_response(1, 'files must be an array');

		// validate post data
		//OnlineImages::validate($post);

		// move uploaded files
		for ($i=0; $i < count($files['files']['tmp_name']); $i++) { 
			$uploadfile = $uploaddir . basename($files['files']['name'][$i]);

			// Check file type, make sure it's a jpeg
			if(!preg_match('/(image\/png|image\/jpe?g|image\/gif)/', $files['files']['type'][$i])) json_response(1, 'not a supported MIME type');

			// Check filenames for underscores
			if(!preg_match('/_/', $uploadfile)) json_response(1, 'filename pattern not matched: slug_size.jpg example background_full.jpg.');

			// if move fails
			if (!move_uploaded_file($files['files']['tmp_name'][$i], $uploadfile)) json_response(1, 'move_uploaded_file failed');

			// add image paths to array so all can be ftp in one connection
			$file_paths[] = $uploadfile;
		}
/*
		// FTP files to GAMS
		$files_ftped = OnlineImages::ftp($file_paths);

		// Build GAMS request array
		// $post: $_POST metadata
		// $files_ftped: list of filenames that were uploaded
		// $file_paths: paths to files that were uploaded
		$gams_args = OnlineImages::generate_gams_args($post, $files_ftped, $file_paths);

		// Send request to GAMS
		$gams_response = OnlineImages::gams_request($gams_args);

		// Delete POST files
		OnlineImages::delete($file_paths);

		$log = [];
		$log['endpoint'] = 'OnlineImages';
		$log['env']      = $_ENV['ENV'];
		$log['incoming_request_payload'] = $post;
		$log['outgoing_request_payload'] = $gams_args;
		$log['incoming_response_payload'] = $gams_response;

		Helpers::log($log);

		// success message
		json_response(201, $gams_response);
	}

	private static function generate_gams_args($post, $files_ftped, $file_paths){
		
		function get_sizes($filenames){
			$sizes = array();
			foreach ($filenames as $filename) {
				$filename = pathinfo($filename);
				$filename = explode('_', $filename['filename']);
				$sizes[] = end($filename);
			}
			return $sizes;
		}

		function crop_ids($count){
			$ids = array();
			for ($i=0; $i < $count; $i++) { 
				$ids[] = $i;
			}
			return implode('|', $ids);
		}

		$sizes = get_sizes($files_ftped);
		
		// Prepare GAMS $args
		$gams_args = array(
			'fileList' => implode('|', $files_ftped),
			'sizeList' => implode('|', $sizes),
			'credit' => urlencode($post['credit']),
			'caption' => urlencode($post['caption']),
			'graphic_kind' => ($post['graphic_kind']) ? : 'Photo',
			'mainSize' => $sizes[0],
			'cropID' => crop_ids(count($files_ftped)),
			'slug' => $files_ftped[0]
		);

		return $gams_args;
	}

	private static function validate($data){
		if(!$data) json_response(1, 'there is something wrong with your request.');

		$rules = [
			'required' => [['caption'],['product'],['credit']],
			'slug' => [['product']]
		];

		$v = new Valitron\Validator($data);

		$v->rules($rules);

		if(!$v->validate()) json_response(1, $v->errors());
	}

	private static function ftp($file_paths){

		// check if $files is array
		if(!is_array($file_paths)) json_response(1, 'file_paths must be an array');

		$filenames = array();

		switch ($_ENV['ENV']) {
			case 'production':
				$server = 'gamsprd.dowjones.net';
				break;

			default:
				$server = 'gamsqa.mcn.dowjones.com';
				break;
		}

		//ftp usernaem/password for both Production and QA
		$username    = 'wsjie';
		$password    = 'wsjie';

		// set up basic connection
		$connection = @ftp_connect($server, 21) or json_response(1, "could not connect to GAMS $env FTP");
		$login      = ftp_login($connection, $username, $password);

		// ftp to GAMS
		ftp_pasv($connection, true);
		ftp_chdir($connection, 'IN/');
		 
		// loop through files and ftp
		foreach($file_paths as $file_path){
			$filename = basename($file_path);
			$filenames[] = $filename;
			if(!ftp_put($connection, $filename, $file_path, FTP_BINARY)) json_response(1, "FTP to GAMS $env failed");
		}

		ftp_close($connection);

		return $filenames;
	}

	private static function delete($file_paths){
		foreach($file_paths as $file_path){
			if(!unlink($file_path)) json_response(1, "could not delete files");
		}
	}

	private static function gams_request($args){

		switch ($_ENV['ENV']) {
			case 'production':
				$server   = 'http://gamsprd.dowjones.net/gamscgi/WSJIEOnlineAutomated.pl?';
				$base_url = 'http://si.wsj.net/public/resources/images/';
				break;

			default:
				$server   = 'http://gamsqa.mcn.dowjones.com/gamscgi/WSJIEOnlineAutomated.pl?';
				$base_url = 'http://online.s.dev.wsj.com/public/resources/images/';
				break;
		}

		$request_array = array();
		$request = array(
			'FileList' => $args['fileList'],
			'UpdateOnSite' => 1,
			'SizeList' => $args['sizeList'],
			'Section' => 'BN',
			'Credit' => $args['credit'],
			'Caption' => $args['caption'],
			'MainSize' => $args['mainSize'], 
			'CropID' => $args['cropID'],
			'Slug' => $args['slug'],
			'GraphicKind' => $args['graphic_kind'],
			'callback' => 'gamsqa.mcn.dowjones.com'
		);

		foreach ($request as $key => $value) {
			$request_array[] = $key . "=" . $value;
		}

		$request_string = implode('&', $request_array);
		$url            = $server . $request_string;

		// debug
		// echo $url;
		// exit();

		$ch       = curl_init($url);
		curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
		$response = curl_exec($ch);

		curl_close($ch);

		$decoded = json_decode($response, true);

		if($decoded['code'] !== 200) json_response(1, $decoded);

		$res = array(
			'gams_id' => $decoded['data']['GraphicName'],
			'original_names' => $decoded['data']['OriginalName'],
			'urls' => array()
		);

		// build urls from gams response
		foreach ($decoded['data']['NewName'] as $new_name) {
			$res['urls'][] = $base_url . $new_name;
		}

		// returns GAMS number and list of urls
		return $res;
*/
//	}	
//}